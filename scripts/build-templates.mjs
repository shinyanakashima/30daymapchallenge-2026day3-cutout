// 国土数値情報 N03（行政区域）2026年版から、自治体ごとの「型の原本」を作る。
// - 同じ行政区域コード（N03_007）の地物だけを Union する（別自治体とは結合しない）
// - 離島も同じ自治体の一部として残す（本島抽出はしない）
// - 政令指定都市は「区」単位に加えて、区を束ねた「市全体」も作る
// 生成物:
//   public/templates/prefectures.json        47都道府県と整備状況
//   public/templates/<pp>/index.json         自治体一覧（小さなカタログ）
//   public/templates/<pp>/<code>.geojson     自治体1つの型（EPSG:6668 経緯度）
// 使い方: node scripts/build-templates.mjs 01 13 27 47
//   zip が data/raw/n03/ に無ければ国土数値情報のサイトから取得する。
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data/raw/n03');
const OUT = path.join(ROOT, 'public/templates');
const YEAR = '2026';
const VERSION = 'N03-20260101';
const PRECISION = 1e6; // 経緯度 小数6桁（約0.1m）。N03 の位置精度より十分細かく、形状の簡略化はしない

const PREFS = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

const args = process.argv.slice(2).filter((a) => /^\d{1,2}$/.test(a)).map((a) => a.padStart(2, '0'));
if (args.length === 0) {
  console.error('usage: node scripts/build-templates.mjs 01 [13 27 ...]');
  process.exit(1);
}

async function ensureZip(pp) {
  const name = `${VERSION}_${pp}_GML.zip`;
  const file = path.join(RAW, name);
  if (existsSync(file)) return file;
  await mkdir(RAW, { recursive: true });
  const url = `https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-${YEAR}/${name}`;
  console.log(`download ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${r.status} ${url}`);
  await writeFile(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

function roundCoords(c) {
  if (typeof c[0] === 'number') return [Math.round(c[0] * PRECISION) / PRECISION, Math.round(c[1] * PRECISION) / PRECISION];
  return c.map(roundCoords);
}

const db = await DuckDBInstance.create(':memory:');
const con = await db.connect();
await con.run('INSTALL spatial; LOAD spatial;');
const engine = (await con.runAndReadAll('SELECT version() v')).getRowObjectsJson()[0].v;

for (const pp of args) {
  const prefName = PREFS[Number(pp) - 1];
  const zip = await ensureZip(pp);
  const zipStat = await stat(zip);
  const src = `/vsizip/${zip.replaceAll('\\', '/')}/${VERSION}_${pp}.geojson`;
  console.log(`[${pp}] ${prefName} read ${src}`);
  const t0 = Date.now();
  await con.run(`CREATE OR REPLACE TABLE raw AS SELECT * FROM ST_Read('${src.replaceAll("'", "''")}')`);
  const rawCount = (await con.runAndReadAll('SELECT count(*)::INT n, count(*) FILTER (WHERE N03_007 IS NULL)::INT nn FROM raw')).getRowObjectsJson()[0];

  // 同一コード内の名称の一貫性を確認
  const incons = (await con.runAndReadAll(`
    SELECT N03_007 FROM raw WHERE N03_007 IS NOT NULL
    GROUP BY N03_007 HAVING count(DISTINCT coalesce(N03_004,'') || '|' || coalesce(N03_005,'')) > 1`)).getRowObjectsJson();
  if (incons.length) console.warn(`[${pp}] 同じコードで名称が異なる地物: ${incons.map((r) => r.N03_007).join(',')}`);

  await con.run(`
    CREATE OR REPLACE TABLE units AS
    SELECT N03_007 AS code,
           any_value(N03_002) AS n2, any_value(N03_003) AS n3,
           any_value(N03_004) AS n4, any_value(N03_005) AS n5,
           count(*)::INT AS src_features,
           ST_MakeValid(ST_Union_Agg(geom)) AS geom
    FROM raw WHERE N03_007 IS NOT NULL
    GROUP BY N03_007`);
  // 政令指定都市：区を束ねた市全体（区コードの1の位を0にしたものを市コードとする）
  await con.run(`
    INSERT INTO units
    SELECT lpad(((min(code)::INT // 10) * 10)::VARCHAR, 5, '0') AS code,
           any_value(n2), any_value(n3), n4, NULL AS n5,
           sum(src_features)::INT, ST_MakeValid(ST_Union_Agg(geom))
    FROM units WHERE n5 IS NOT NULL
    GROUP BY n4`);

  const rows = (await con.runAndReadAll(`
    SELECT code, n2, n3, n4, n5, src_features,
           ST_GeometryType(geom)::VARCHAR AS gtype,
           ST_NumGeometries(geom)::INT AS parts,
           ST_NPoints(geom)::INT AS vertices,
           ST_XMin(geom) xmin, ST_YMin(geom) ymin, ST_XMax(geom) xmax, ST_YMax(geom) ymax,
           ST_IsValid(geom) AS valid,
           ST_AsGeoJSON(ST_CollectionExtract(geom, 3)) AS gj
    FROM units ORDER BY code, n5 NULLS FIRST`)).getRowObjectsJson();

  const dir = path.join(OUT, pp);
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) if (f.endsWith('.geojson')) await import('node:fs/promises').then((m) => m.rm(path.join(dir, f)));

  const index = [];
  let bytes = 0;
  for (const r of rows) {
    const isWard = r.n5 != null;
    const isDesignatedCity = !isWard && rows.some((x) => x.n5 != null && x.n4 === r.n4);
    const name = isWard ? `${r.n4}${r.n5}` : r.n4;
    const geometry = JSON.parse(r.gj);
    geometry.coordinates = roundCoords(geometry.coordinates);
    const feature = {
      type: 'Feature',
      properties: {
        code: r.code,
        name,
        prefecture: prefName,
        prefectureCode: pp,
        kind: isWard ? 'ward' : isDesignatedCity ? 'designated-city' : 'municipality',
        source: `国土数値情報 行政区域データ ${VERSION}（N03）`,
        crs: 'EPSG:6668',
      },
      geometry,
    };
    const text = JSON.stringify(feature);
    bytes += text.length;
    await writeFile(path.join(dir, `${r.code}.geojson`), text);
    index.push({
      code: r.code,
      name,
      kind: feature.properties.kind,
      group: r.n2 ?? null, // 振興局など
      county: r.n3 ?? null, // 郡・政令市
      parts: r.parts,
      vertices: r.vertices,
      srcFeatures: r.src_features,
      valid: r.valid,
      bbox: [r.xmin, r.ymin, r.xmax, r.ymax].map((v) => Math.round(Number(v) * 1e6) / 1e6),
      bytes: text.length,
    });
  }
  await writeFile(
    path.join(dir, 'index.json'),
    JSON.stringify({
      prefectureCode: pp,
      prefecture: prefName,
      source: `国土数値情報 行政区域データ ${VERSION}（N03）`,
      sourceUrl: `https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-${YEAR}/${VERSION}_${pp}_GML.zip`,
      sourceZipBytes: zipStat.size,
      rawFeatures: rawCount.n,
      rawFeaturesWithoutCode: rawCount.nn,
      crs: 'EPSG:6668',
      coordinatePrecision: "1e-6 deg",
      engine: `DuckDB ${engine} + spatial`,
      generatedAt: new Date().toISOString(),
      units: index,
    }),
  );
  console.log(`[${pp}] ${index.length} units (${index.filter((u) => u.kind === 'designated-city').length} designated cities), ${(bytes / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms`);
}

// 47都道府県の整備状況
const prefs = [];
for (let i = 0; i < 47; i++) {
  const pp = String(i + 1).padStart(2, '0');
  const idx = path.join(OUT, pp, 'index.json');
  let units = 0;
  if (existsSync(idx)) units = JSON.parse(await readFile(idx, 'utf8')).units.length;
  prefs.push({ code: pp, name: PREFS[i], ready: units > 0, units });
}
await writeFile(path.join(OUT, 'prefectures.json'), JSON.stringify({ source: `国土数値情報 N03 ${VERSION}`, prefectures: prefs }, null, 1));
console.log(`prefectures ready: ${prefs.filter((p) => p.ready).map((p) => p.code).join(',')}`);
