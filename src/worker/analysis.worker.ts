/// <reference lib="webworker" />
// 解析Worker：DuckDB-Wasm + spatial で「候補取得 → 型による切断 → GeoJSON化」を行う。
// - SQLはこのファイル内の固定文のみ。外部から受け取るのは検証済みの数値と、カタログ由来の素材URLだけ
// - 候補（未切断の元の建物）のキャッシュと、切り抜き結果は別テーブルで保持する
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import type { BBox, CutoutStats, MaterialRef, Req, Res, Stage, StageTiming, Transfer } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
const NET_CHANNEL = 'cutout-duckdb-net';
const net = { requests: 0, bytes: 0, rangeRequests: 0, fullRequests: 0, failed: 0 };
const netChannel = new BroadcastChannel(NET_CHANNEL);
netChannel.onmessage = (ev: MessageEvent<{ method: string; url: string; range: string | null; status: number; bytes: number }>) => {
  const r = ev.data;
  if (!/^https:\/\/data\.source\.coop\//.test(r.url)) return; // 素材の取得だけを数える（拡張の取得は除く）
  net.requests++;
  net.bytes += r.bytes;
  if (r.status === 206) net.rangeRequests++;
  else if (r.status === 200 && r.method === 'GET') net.fullRequests++;
  else if (r.status >= 400 || r.status === 0) net.failed++;
};
const netSnapshot = () => ({ ...net });
/** BroadcastChannel の通知は非同期に届くため、少し待ってから差分を取る */
async function netDelta(before: Transfer): Promise<Transfer> {
  await new Promise((r) => setTimeout(r, 60));
  return {
    requests: net.requests - before.requests,
    bytes: net.bytes - before.bytes,
    rangeRequests: net.rangeRequests - before.rangeRequests,
    fullRequests: net.fullRequests - before.fullRequests,
    failed: net.failed - before.failed,
  };
}
const PIECE_MAX_VERTICES = 128; // 型の小片あたりの最大頂点数

interface MaterialState {
  ref: MaterialRef;
  fileName: string;
  fullFile?: string; // ファイル全体をメモリに保持した場合の登録名
  fullBytes?: number;
  epsg: number;
  hasBBoxColumns: boolean;
}
let material: MaterialState | null = null;

interface TemplateState {
  code: string;
  epsg: number;
}
let template: TemplateState | null = null;

interface CacheState {
  materialId: string;
  epsg: number;
  bboxM: BBox;
  count: number;
  vertices: number;
}
let cache: CacheState | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

function post(msg: Res, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`数値が不正です: ${name}`);
  return v;
}
function epsgOk(v: unknown): number {
  const n = num(v, 'EPSG');
  // UTM（WGS84: 32601-32660）または JGD2011 UTM（6688-6692）のみ許可
  if (!Number.isInteger(n) || !((n >= 32601 && n <= 32660) || (n >= 6688 && n <= 6692))) {
    throw new Error(`解析CRSが許可範囲外です: ${n}`);
  }
  return n;
}
function bboxOk(b: BBox, name: string): BBox {
  const r = { minx: num(b?.minx, name), miny: num(b?.miny, name), maxx: num(b?.maxx, name), maxy: num(b?.maxy, name) };
  if (r.minx > r.maxx || r.miny > r.maxy) throw new Error(`範囲が不正です: ${name}`);
  return r;
}
const lit = (n: number) => num(n, 'literal').toPrecision(17);

async function q(sql: string) {
  if (!conn) throw new Error('DuckDB が初期化されていません');
  return conn.query(sql);
}
async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  const t = await q(sql);
  const row = t.get(0);
  return (row ? row.toJSON() : {}) as T;
}

async function init(reqId: number) {
  const t0 = performance.now();
  post({ type: 'progress', reqId, stage: 'engine', message: 'DuckDB-Wasm を起動中' });
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  // DuckDB の Worker が行う HTTP 取得（同期XHR）を数えるため、計測用の薄いラッパーを先に読み込む。
  // 取得内容は変えず、URL・Range・状態・受信バイト数だけを BroadcastChannel で知らせる
  const mainWorkerUrl = new URL(bundle.mainWorker!, self.location.href).href;
  const wrapper = `
    (function () {
      var ch = new BroadcastChannel(${JSON.stringify(NET_CHANNEL)});
      var P = XMLHttpRequest.prototype, open = P.open, send = P.send, setH = P.setRequestHeader;
      P.open = function (m, u) { this.__m = m; this.__u = String(u); this.__r = null; return open.apply(this, arguments); };
      P.setRequestHeader = function (k, v) { if (String(k).toLowerCase() === 'range') this.__r = String(v); return setH.apply(this, arguments); };
      P.send = function () {
        var x = this, t0 = performance.now();
        var report = function () {
          var n = 0;
          try { if (x.response && x.response.byteLength !== undefined) n = x.response.byteLength; else if (typeof x.responseText === 'string') n = x.responseText.length; } catch (e) {}
          try { ch.postMessage({ method: x.__m, url: x.__u, range: x.__r, status: x.status, bytes: n, ms: performance.now() - t0 }); } catch (e) {}
        };
        x.addEventListener('loadend', report);
        return send.apply(this, arguments);
      };
    })();
    importScripts(${JSON.stringify(mainWorkerUrl)});`;
  const worker = new Worker(URL.createObjectURL(new Blob([wrapper], { type: 'text/javascript' })));
  const logger = new duckdb.VoidLogger();
  db = new duckdb.AsyncDuckDB(logger, worker);
  worker.addEventListener('error', (e) => post({ type: 'error', reqId, stage: 'engine', message: `DuckDB Worker のエラー: ${e.message || '不明'}` }));
  // Blob の Worker からも解決できるよう絶対URLにする。起動が止まったら永久待ちにせずエラーにする
  const abs = (u: string | null | undefined) => (u ? new URL(u, self.location.href).href : u);
  await withTimeout(
    db.instantiate(abs(bundle.mainModule)!, abs(bundle.pthreadWorker)),
    60_000,
    'DuckDB-Wasm の起動が60秒以内に完了しませんでした',
  );
  // HTTP は Range による部分取得を使う（全体ダウンロードへのフォールバックは許可しない）
  await db.open({
    filesystem: { reliableHeadRequests: true, allowFullHTTPReads: false, forceFullHTTPReads: false },
  });
  conn = await db.connect();
  const engineVersion = String((await one<{ v: string }>('SELECT version() AS v')).v);
  post({ type: 'progress', reqId, stage: 'engine', message: `spatial 拡張を読込中（${engineVersion}）` });
  await withTimeout(q('INSTALL spatial; LOAD spatial;'), 90_000, 'spatial 拡張の読込が90秒以内に完了しませんでした');
  const ext = await one<{ v: string }>(
    "SELECT coalesce(extension_version, '') AS v FROM duckdb_extensions() WHERE extension_name = 'spatial'",
  );
  post({
    type: 'ready',
    reqId,
    engineVersion,
    spatialVersion: ext.v,
    ms: performance.now() - t0,
  });
}

async function setMaterial(reqId: number, ref: MaterialRef, analysisEpsg: number) {
  const t0 = performance.now();
  const net0 = netSnapshot();
  const epsg = epsgOk(analysisEpsg);
  if (!/^https:\/\/data\.source\.coop\/pacificspatial\/flateau-2-0\/[\w\-./]+_building_lod0\.parquet$/.test(ref.href)) {
    throw new Error('素材URLがカタログの形式と一致しません');
  }
  if (ref.crs !== 'EPSG:6668') throw new Error(`未対応の素材CRSです: ${ref.crs}`);
  post({ type: 'progress', reqId, stage: 'material', message: 'スキーマを確認中（ヘッダのみ取得）' });
  // 素材ごとに別名で登録。別素材のデータを混ぜない
  const fileName = `material_${ref.itemId.replace(/[^\w-]/g, '_')}.parquet`;
  await db!.registerFileURL(fileName, ref.href, duckdb.DuckDBDataProtocol.HTTP, false);
  const desc = await q(`DESCRIBE SELECT * FROM read_parquet('${fileName}')`);
  const columns: string[] = [];
  let geometryType = '';
  for (const row of desc) {
    const r = row!.toJSON() as { column_name: string; column_type: string };
    columns.push(r.column_name);
    if (r.column_name === 'GEOM') geometryType = r.column_type;
  }
  for (const c of ['gml_id', 'measured_height', 'cal_height_m', 'GEOM']) {
    if (!columns.includes(c)) throw new Error(`素材に必要な列がありません: ${c}`);
  }
  const hasBBoxColumns = ['cal_xmin', 'cal_xmax', 'cal_ymin', 'cal_ymax'].every((c) => columns.includes(c));
  // 初期配置の目安：Parquet フッタの行グループ統計（座標列の min/max）だけを使い、
  // 建物密度（件数/面積）が最も高い行グループの範囲中心を返す。建物本体は読まない
  let denseCenter: [number, number] | null = null;
  if (hasBBoxColumns) {
    const rg = await q(`
      SELECT row_group_id, any_value(row_group_num_rows)::BIGINT AS n,
             min(CASE WHEN path_in_schema = 'cal_xmin' THEN TRY_CAST(stats_min AS DOUBLE) END) AS x0,
             max(CASE WHEN path_in_schema = 'cal_xmax' THEN TRY_CAST(stats_max AS DOUBLE) END) AS x1,
             min(CASE WHEN path_in_schema = 'cal_ymin' THEN TRY_CAST(stats_min AS DOUBLE) END) AS y0,
             max(CASE WHEN path_in_schema = 'cal_ymax' THEN TRY_CAST(stats_max AS DOUBLE) END) AS y1
      FROM parquet_metadata('${fileName}') GROUP BY row_group_id`);
    let best = -1;
    for (const row of rg) {
      const r = row!.toJSON() as { n: bigint | number; x0: number; x1: number; y0: number; y1: number };
      if (![r.x0, r.x1, r.y0, r.y1].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      const area = Math.max((r.x1 - r.x0) * (r.y1 - r.y0), 1e-8);
      const density = Number(r.n) / area;
      if (density > best) {
        best = density;
        denseCenter = [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
      }
    }
  }
  // 前の素材をメモリに保持していれば解放する（別素材のデータを残さない）
  if (material?.fullFile) await db!.dropFile(material.fullFile).catch(() => undefined);
  material = { ref, fileName, epsg, hasBBoxColumns };
  // 素材切替時は候補キャッシュと結果を破棄
  await q('DROP TABLE IF EXISTS cand; DROP TABLE IF EXISTS res;');
  cache = null;
  post({
    type: 'materialReady',
    reqId,
    materialId: ref.id,
    columns,
    hasBBoxColumns,
    geometryType,
    denseCenter,
    transfer: await netDelta(net0),
    ms: performance.now() - t0,
  });
}

async function setTemplate(reqId: number, code: string, geojson: string, templateEpsg: number) {
  const t0 = performance.now();
  const epsg = epsgOk(templateEpsg);
  if (!/^\d{5}$/.test(code)) throw new Error('自治体コードが不正です');
  let geom: unknown;
  try {
    const parsed = JSON.parse(geojson);
    geom = parsed.type === 'Feature' ? parsed.geometry : parsed;
  } catch {
    throw new Error('型のGeoJSONを解析できません');
  }
  const g = geom as { type?: string };
  if (g?.type !== 'Polygon' && g?.type !== 'MultiPolygon') throw new Error('型は Polygon/MultiPolygon である必要があります');
  post({ type: 'progress', reqId, stage: 'template', message: '型を解析平面へ変換中' });
  // GeoJSON はプリペアドステートメントのパラメータとして渡す（SQL文字列へ埋め込まない）
  const stmt = await conn!.prepare(`
    CREATE OR REPLACE TABLE tpl AS
    SELECT ST_MakeValid(ST_Transform(ST_GeomFromGeoJSON(?), 'EPSG:6668', 'EPSG:${epsg}', always_xy := true)) AS g`);
  await stmt.query(JSON.stringify(geom));
  await stmt.close();
  const info = await one<{ v: number; p: number }>('SELECT ST_NPoints(g)::INT AS v, ST_NumGeometries(g)::INT AS p FROM tpl');
  template = { code, epsg };
  await q('DROP TABLE IF EXISTS res;');
  post({ type: 'templateReady', reqId, code, ms: performance.now() - t0, vertices: Number(info.v), parts: Number(info.p) });
}

/** 素材ファイル全体を取得（full モードのみ）。進捗を返しながら読む */
async function downloadWhole(url: string, onProgress: (got: number, total: number | null) => void): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`素材ファイルを取得できません（HTTP ${r.status}）`);
  const total = Number(r.headers.get('content-length')) || null;
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    if (performance.now() - last > 250) {
      last = performance.now();
      onProgress(got, total);
    }
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  net.requests++;
  net.fullRequests++;
  net.bytes += got;
  return out;
}

function contains(outer: BBox, inner: BBox) {
  return outer.minx <= inner.minx && outer.miny <= inner.miny && outer.maxx >= inner.maxx && outer.maxy >= inner.maxy;
}

function encode(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

async function cutout(req: Extract<Req, { type: 'cutout' }>) {
  const { reqId, jobId } = req;
  if (!material || material.ref.id !== req.materialId) throw new Error('素材が選択状態と一致しません（再選択してください）');
  if (!template || template.code !== req.templateCode) throw new Error('型が選択状態と一致しません（再選択してください）');
  const p = req.placement;
  const cx = num(p.cx, 'cx'), cy = num(p.cy, 'cy'), w0 = num(p.w0, 'w0'), width = num(p.width, 'width');
  const rot = num(p.rotationDeg, 'rotation'), tx = num(p.tx, 'tx'), ty = num(p.ty, 'ty');
  if (w0 <= 0 || width <= 0 || width > 200_000) throw new Error('幅が不正です');
  const placedBBox = bboxOk(req.placedBBox, 'placedBBox');
  const fetchM = bboxOk(req.fetchBBoxM, 'fetchBBoxM');
  const fetchLL = bboxOk(req.fetchBBoxLonLat, 'fetchBBoxLonLat');
  const maxCandidates = Math.max(1, Math.floor(num(req.maxCandidates, 'maxCandidates')));

  const timings: StageTiming[] = [];
  const tAll = performance.now();
  const net0 = netSnapshot();
  let t = performance.now();
  const lap = (stage: Stage, note?: string) => {
    const now = performance.now();
    timings.push({ stage, ms: now - t, note });
    t = now;
  };
  const progress = (stage: Stage, message: string) => post({ type: 'progress', reqId, jobId, stage, message });

  const E = material.epsg;
  let candidatesBuf: ArrayBuffer | null = null;
  const cacheHit = !!cache && cache.materialId === material.ref.id && cache.epsg === E && contains(cache.bboxM, placedBBox);

  if (!cacheHit) {
    // 読込方式：range = HTTP Range で必要な列・行グループだけ取得／full = ファイル全体を1回取得してメモリに保持
    if (req.readMode === 'full' && !material.fullFile) {
      progress('fetch', `素材ファイル全体を取得中（${(material.ref.fileSize ?? 0) / 1e6 > 0 ? ((material.ref.fileSize ?? 0) / 1e6).toFixed(1) + ' MB' : '容量不明'}）`);
      const buf = await downloadWhole(material.ref.href, (got, total) =>
        progress('fetch', `素材ファイル全体を取得中 ${(got / 1e6).toFixed(1)} / ${total ? (total / 1e6).toFixed(1) : '?'} MB`),
      );
      const name = material.fileName.replace(/\.parquet$/, '_full.parquet');
      const size = buf.byteLength; // registerFileBuffer で buf は Worker へ移され長さ0になる
      await db!.registerFileBuffer(name, buf);
      material.fullFile = name;
      material.fullBytes = size;
      lap('fetch', `ファイル全体 ${(size / 1e6).toFixed(1)} MB をメモリに保持`);
    }
    const F = req.readMode === 'full' && material.fullFile ? material.fullFile : material.fileName;
    // 取得矩形（外接矩形＋余白）に重なる元の建物を、切断前の形と高さのまま取得する
    const where = material.hasBBoxColumns
      ? `cal_xmax >= ${lit(fetchLL.minx)} AND cal_xmin <= ${lit(fetchLL.maxx)} AND cal_ymax >= ${lit(fetchLL.miny)} AND cal_ymin <= ${lit(fetchLL.maxy)}`
      : `ST_Intersects(GEOM, ST_MakeEnvelope(${lit(fetchLL.minx)}, ${lit(fetchLL.miny)}, ${lit(fetchLL.maxx)}, ${lit(fetchLL.maxy)}))`;
    // 件数の上限確認は取得と同じ1回の読込で行う（上限+1件で止める）。超えた場合は結果を捨てて確認を求める。間引きはしない
    const limit = req.force ? '' : `LIMIT ${maxCandidates + 1}`;
    progress('fetch', '取得矩形に重なる元の建物を取得・投影中');
    await q('DROP TABLE IF EXISTS cand; DROP TABLE IF EXISTS res;');
    cache = null;
    await q(`
      CREATE TABLE cand AS
      SELECT gml_id,
             CASE WHEN measured_height > 0 THEN measured_height
                  WHEN cal_height_m > 0 THEN cal_height_m END::DOUBLE AS height_m,
             CASE WHEN measured_height > 0 THEN 'measured_height'
                  WHEN cal_height_m > 0 THEN 'cal_height_m' END AS height_src,
             g AS geom,
             ST_XMin(g) AS bx0, ST_YMin(g) AS by0, ST_XMax(g) AS bx1, ST_YMax(g) AS by1
      FROM (
        SELECT gml_id, measured_height, cal_height_m,
               ST_Transform(GEOM::GEOMETRY, 'EPSG:6668', 'EPSG:${E}', always_xy := true) AS g
        FROM (SELECT gml_id, measured_height, cal_height_m, GEOM FROM read_parquet('${F}') WHERE ${where} ${limit})
      )`);
    const n0 = Number((await one<{ n: number }>('SELECT count(*)::INT AS n FROM cand')).n);
    if (!req.force && n0 > maxCandidates) {
      await q('DROP TABLE IF EXISTS cand;');
      lap('fetch', `${maxCandidates} 件超で停止`);
      post({ type: 'needsConfirm', reqId, jobId, candidates: n0, limit: maxCandidates, ms: performance.now() - tAll, timings, transfer: await netDelta(net0) });
      return;
    }
    const cs = await one<{ n: number; v: number }>('SELECT count(*)::INT AS n, coalesce(sum(ST_NPoints(geom)), 0)::BIGINT AS v FROM cand');
    cache = { materialId: material.ref.id, epsg: E, bboxM: fetchM, count: Number(cs.n), vertices: Number(cs.v) };
    lap('fetch', `${cache.count} 件 / ${cache.vertices} 頂点`);
    // 表示用：未切断の元の建物（経緯度）
    const cj = await one<{ j: string }>(`
      SELECT '{"type":"FeatureCollection","features":[' || coalesce(string_agg(
        '{"type":"Feature","properties":{"gml_id":' || to_json(gml_id) || ',"height_m":' || coalesce(height_m::VARCHAR, 'null') ||
        '},"geometry":' || ST_AsGeoJSON(ST_Transform(geom, 'EPSG:${E}', 'EPSG:4326', always_xy := true)) || '}', ','), '') || ']}' AS j
      FROM cand`);
    candidatesBuf = encode(cj.j);
    lap('fetch', '候補の表示用GeoJSON');
  }

  // 型の配置（ST_Affine）。同じ自治体の MultiPolygon 全体に同じ変換をかける
  progress('intersect', '型を配置して切断中');
  const s = width / w0;
  const th = (rot * Math.PI) / 180;
  const a = s * Math.cos(th), b = -s * Math.sin(th), d = s * Math.sin(th), e = s * Math.cos(th);
  const xoff = tx - a * cx - b * cy, yoff = ty - d * cx - e * cy;
  await q(`
    CREATE OR REPLACE TABLE placed AS
    SELECT ST_MakeValid(ST_Affine(g, ${lit(a)}, ${lit(b)}, ${lit(d)}, ${lit(e)}, ${lit(xoff)}, ${lit(yoff)})) AS g FROM tpl`);
  // 大きな行政界を小片に分けて空間結合（R-tree）を使う。
  // 外接矩形を長辺方向に二分する再帰で、各片の頂点数を一定以下にする（ST_Subdivide 非搭載の Wasm 版でも動く）。
  // 切断結果は小片ごとの交差を建物ごとに Union して得る（面積は元の交差と一致）
  await q(`
    CREATE OR REPLACE TABLE pieces AS
    WITH RECURSIVE sub(depth, g) AS (
      SELECT 0, g FROM placed
      UNION ALL
      SELECT s.depth + 1, ST_CollectionExtract(ST_Intersection(s.g, e.env), 3)
      FROM (SELECT depth, g, ST_XMin(g) AS x0, ST_YMin(g) AS y0, ST_XMax(g) AS x1, ST_YMax(g) AS y1
            FROM sub WHERE ST_NPoints(g) > ${PIECE_MAX_VERTICES} AND depth < 24) s,
      LATERAL (SELECT unnest(CASE WHEN s.x1 - s.x0 >= s.y1 - s.y0
          THEN [ST_MakeEnvelope(s.x0, s.y0, (s.x0 + s.x1) / 2, s.y1), ST_MakeEnvelope((s.x0 + s.x1) / 2, s.y0, s.x1, s.y1)]
          ELSE [ST_MakeEnvelope(s.x0, s.y0, s.x1, (s.y0 + s.y1) / 2), ST_MakeEnvelope(s.x0, (s.y0 + s.y1) / 2, s.x1, s.y1)]
        END) AS env) e
    )
    SELECT row_number() OVER () AS pid, x.geom AS g
    FROM (SELECT unnest(ST_Dump(g)) AS x FROM sub
          WHERE (ST_NPoints(g) <= ${PIECE_MAX_VERTICES} OR depth >= 24) AND NOT ST_IsEmpty(g))
    WHERE ST_Dimension(x.geom) = 2`);
  const pc = await one<{ n: number }>('SELECT count(*)::INT AS n FROM pieces');
  lap('intersect', `型を ${pc.n} 片に分割`);
  const pb = await one<{ x0: number; y0: number; x1: number; y1: number; n: number }>(
    'SELECT ST_XMin(g) AS x0, ST_YMin(g) AS y0, ST_XMax(g) AS x1, ST_YMax(g) AS y1 FROM placed',
  );
  await q(`
    CREATE OR REPLACE TABLE hit AS
    SELECT c.gml_id, c.height_m, c.height_src, c.geom,
           ST_Covers(p.g, c.geom) AS cov,
           CASE WHEN ST_Covers(p.g, c.geom) THEN NULL ELSE ST_Intersection(c.geom, p.g) END AS part
    FROM (SELECT * FROM cand
          WHERE bx1 >= ${lit(Number(pb.x0))} AND bx0 <= ${lit(Number(pb.x1))}
            AND by1 >= ${lit(Number(pb.y0))} AND by0 <= ${lit(Number(pb.y1))}) c
    JOIN pieces p ON ST_Intersects(c.geom, p.g)`);
  await q(`
    CREATE OR REPLACE TABLE res AS
    WITH agg AS (
      SELECT gml_id, any_value(height_m) AS height_m, any_value(height_src) AS height_src,
             bool_or(cov) AS whole, any_value(geom) AS src, ST_Union_Agg(part) AS u
      FROM hit GROUP BY gml_id
    ), cut AS (
      SELECT gml_id, height_m, height_src, whole,
             CASE WHEN whole THEN src ELSE ST_CollectionExtract(ST_MakeValid(u), 3) END AS g
      FROM agg
    )
    SELECT * FROM cut WHERE g IS NOT NULL AND NOT ST_IsEmpty(g) AND ST_Area(g) > 0`);
  const st = await one<Record<string, number>>(`
    SELECT (SELECT count(DISTINCT gml_id) FROM hit)::INT AS touching,
           count(*)::INT AS n,
           count(*) FILTER (WHERE whole)::INT AS whole,
           count(*) FILTER (WHERE NOT whole)::INT AS cut,
           count(*) FILTER (WHERE ST_NumGeometries(g) > 1)::INT AS multi,
           count(*) FILTER (WHERE NOT ST_IsValid(g))::INT AS invalid,
           count(*) FILTER (WHERE height_m IS NULL)::INT AS hmiss
    FROM res`);
  lap('intersect', `${st.n} 件`);

  progress('export', 'GeoJSON に変換中');
  const tplCode = template.code;
  const mid = material.ref.id;
  const rj = await one<{ j: string }>(`
    SELECT '[' || coalesce(string_agg(
      '{"type":"Feature","id":' || to_json(${sqlStr(mid + ':' + tplCode + ':')} || gml_id) ||
      ',"properties":{"result_id":' || to_json(${sqlStr(mid + ':' + tplCode + ':')} || gml_id) ||
      ',"gml_id":' || to_json(gml_id) ||
      ',"height_m":' || coalesce(height_m::VARCHAR, 'null') ||
      ',"height_src":' || coalesce(to_json(height_src)::VARCHAR, 'null') ||
      ',"cut":' || (NOT whole)::VARCHAR ||
      '},"geometry":' || ST_AsGeoJSON(ST_Transform(g, 'EPSG:${E}', 'EPSG:4326', always_xy := true)) || '}', ','), '') || ']' AS j
    FROM res`);
  lap('export');

  const stats: CutoutStats = {
    cacheHit,
    cacheBBoxM: cache!.bboxM,
    candidatesInCache: cache!.count,
    candidateVertices: cache!.vertices,
    candidatesTouching: Number(st.touching),
    wholeBuildings: Number(st.whole),
    cutBuildings: Number(st.cut),
    outputFeatures: Number(st.n),
    multiPartFeatures: Number(st.multi),
    invalidAfterFix: Number(st.invalid),
    droppedEmpty: Number(st.touching) - Number(st.n),
    heightMissing: Number(st.hmiss),
    timings,
    totalMs: performance.now() - tAll,
    transfer: await netDelta(net0),
  };
  const result = encode(rj.j);
  const transfer: Transferable[] = [result];
  if (candidatesBuf) transfer.push(candidatesBuf);
  post(
    {
      type: 'cutoutResult',
      reqId,
      jobId,
      materialId: mid,
      templateCode: tplCode,
      placement: { cx, cy, w0, width, rotationDeg: rot, tx, ty },
      result,
      candidates: candidatesBuf,
      stats,
    },
    transfer,
  );
}

/** 文字列リテラル（カタログ由来の ID のみ使用）。単引用符をエスケープ */
function sqlStr(s: string) {
  return `'${s.replaceAll("'", "''")}'`;
}

const STAGE_OF: Record<Req['type'], Stage> = {
  init: 'engine',
  setMaterial: 'material',
  setTemplate: 'template',
  cutout: 'intersect',
};

// 1件ずつ順番に処理する（DuckDB 接続を共有するため）
let chain: Promise<void> = Promise.resolve();
ctx.onmessage = (ev: MessageEvent<Req>) => {
  const req = ev.data;
  chain = chain.then(async () => {
    try {
      switch (req.type) {
        case 'init':
          await init(req.reqId);
          break;
        case 'setMaterial':
          await setMaterial(req.reqId, req.material, req.analysisEpsg);
          break;
        case 'setTemplate':
          await setTemplate(req.reqId, req.code, req.geojson, req.templateEpsg);
          break;
        case 'cutout':
          await cutout(req);
          break;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      post({ type: 'error', reqId: req.reqId, jobId: req.type === 'cutout' ? req.jobId : undefined, stage: STAGE_OF[req.type], message });
    }
  });
};
