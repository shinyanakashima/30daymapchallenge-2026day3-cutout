// Flateau V2 の building_lod0 を、変換せずにそのまま R2（バケット geo-opendata）へ複製する。
// - 元ファイルを取得 → 容量を STAC の file:size と照合 → SHA-256 を計算 → 同じバイト列をアップロード
// - キーは <prefix>/flateau-2-0/flateau-v2-by-city/<itemId>/<元のファイル名>（元の配置をそのまま残す）
// - <prefix> の外には書き込まない。削除はしない
// - 結果を public/catalog/mirror.json に記録する（アプリはこれを見て R2 の複製から読む）
//
// 必要な環境変数（プロジェクト共通の名前。秘密ではない）:
//   R2_GEO_OPENDATA_ENDPOINT, R2_GEO_OPENDATA_BUCKET, R2_GEO_OPENDATA_PUBLIC_BASE_URL
// 認証：キーはスクリプトでは扱わない。Claude のクラウド環境のネットワークシークレット（AWS SigV4）が
//   通信の途中で署名する（許可ホスト＝R2 エンドポイント、パスプレフィックス＝/<バケット>/<フォルダ>/）。
//   そのため要求はパス形式（https://<endpoint>/<bucket>/<key>）で送る。
//
// 使い方:
//   node scripts/mirror-materials-to-r2.mjs --prefix <フォルダ名> sapporo-shi-01100 chiyoda-ku-13101
//   node scripts/mirror-materials-to-r2.mjs --prefix <フォルダ名> --all
//   --dry-run  取得・照合だけ行い、アップロードしない
//   --force    R2 に同じものがあっても上げ直す
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'data/raw/flateau');
const MIRROR_JSON = path.join(ROOT, 'public/catalog/mirror.json');
const SOURCE_ROOT = 'https://data.source.coop/pacificspatial/';
const CONCURRENCY = 2;

// ---- 引数 ----
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const pIdx = argv.indexOf('--prefix');
const prefixArg = pIdx >= 0 ? argv[pIdx + 1] : undefined;
const ids = argv.filter((a, i) => !a.startsWith('--') && i !== pIdx + 1);
const dryRun = flag('--dry-run');
const force = flag('--force');
if (!prefixArg || !/^[\w.-]+(\/[\w.-]+)*\/?$/.test(prefixArg) || prefixArg.includes('..')) {
  console.error('--prefix <フォルダ名> を指定してください（英数字・ - _ . / のみ）');
  process.exit(1);
}
const prefix = prefixArg.replace(/\/?$/, '/');

// ---- 環境変数 ----
const upload = !dryRun;
function env(k) {
  const v = process.env[k];
  if (upload && !v) {
    console.error(`環境変数 ${k} がありません`);
    process.exit(1);
  }
  return v ?? '';
}
const endpoint = env('R2_GEO_OPENDATA_ENDPOINT').replace(/\/$/, '');
const bucket = env('R2_GEO_OPENDATA_BUCKET');
const publicBase = env('R2_GEO_OPENDATA_PUBLIC_BASE_URL').replace(/\/?$/, '/');

/** パス形式の URL。キーの各要素をエンコードする */
const objectUrl = (key) => `${endpoint}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function headObject(key) {
  const r = await fetch(objectUrl(key), { method: 'HEAD' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`R2 HEAD 失敗 HTTP ${r.status}（ネットワークシークレットの許可ホスト・パスを確認）`);
  return {
    size: Number(r.headers.get('content-length')),
    sourceEtag: r.headers.get('x-amz-meta-source-etag'),
    sha256: r.headers.get('x-amz-meta-sha256'),
  };
}

async function putObject(key, body, meta) {
  const r = await fetch(objectUrl(key), {
    method: 'PUT',
    body,
    headers: {
      'content-type': 'application/vnd.apache.parquet',
      'cache-control': 'public, max-age=86400',
      'x-amz-meta-source-url': meta.sourceUrl,
      'x-amz-meta-source-etag': meta.sourceEtag ?? '',
      'x-amz-meta-sha256': meta.sha256,
    },
  });
  if (!r.ok) throw new Error(`R2 PUT 失敗 HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// ---- 対象 ----
const catalog = JSON.parse(await readFile(path.join(ROOT, 'public/catalog/materials.json'), 'utf8'));
const targets = flag('--all') ? catalog.materials : catalog.materials.filter((m) => ids.includes(m.itemId));
const unknown = ids.filter((id) => !catalog.materials.some((m) => m.itemId === id));
if (unknown.length) console.warn(`カタログに無い Item ID: ${unknown.join(', ')}`);
if (targets.length === 0) {
  console.error('対象がありません（Item ID か --all を指定）');
  process.exit(1);
}

const mirror = existsSync(MIRROR_JSON) ? JSON.parse(await readFile(MIRROR_JSON, 'utf8')) : { items: {} };

function keyFor(m) {
  if (!m.href.startsWith(SOURCE_ROOT)) throw new Error(`想定外の取得元: ${m.href}`);
  const key = prefix + m.href.slice(SOURCE_ROOT.length);
  if (!key.startsWith(prefix) || key.includes('..')) throw new Error(`キーがフォルダの外を指しています: ${key}`);
  return key;
}

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

function entry(m, key, hash, sourceEtag) {
  return {
    href: publicBase + key.split('/').map(encodeURIComponent).join('/'),
    key,
    bytes: m.fileSize,
    sha256: hash,
    sourceHref: m.href,
    sourceEtag,
    uploadedAt: new Date().toISOString(),
  };
}

async function mirrorOne(m) {
  const key = keyFor(m);
  const t0 = Date.now();
  // R2 に同じもの（元の ETag と容量が一致）があれば省略
  if (upload && !force) {
    const h = await headObject(key);
    if (h) {
      const src = await fetch(m.href, { method: 'HEAD' });
      if (h.size === m.fileSize && h.sourceEtag === src.headers.get('etag')) {
        mirror.items[m.itemId] = mirror.items[m.itemId] ?? entry(m, key, h.sha256, h.sourceEtag);
        return `[skip] ${m.itemId}（R2 に同じものあり）`;
      }
    }
  }
  // 元ファイルを取得（一時ファイル）
  const tmp = path.join(TMP, m.itemId, path.basename(m.href));
  await mkdir(path.dirname(tmp), { recursive: true });
  const r = await fetch(m.href);
  if (!r.ok || !r.body) throw new Error(`${m.itemId}: 取得失敗 HTTP ${r.status}`);
  const sourceEtag = r.headers.get('etag');
  await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp));
  const size = (await stat(tmp)).size;
  if (m.fileSize != null && size !== m.fileSize) {
    await rm(tmp);
    throw new Error(`${m.itemId}: 容量が STAC と一致しません（取得 ${size} / STAC ${m.fileSize}）`);
  }
  const hash = await sha256(tmp);
  if (upload) {
    await putObject(key, await readFile(tmp), { sourceUrl: m.href, sourceEtag, sha256: hash });
    const h = await headObject(key);
    if (!h || h.size !== size) throw new Error(`${m.itemId}: アップロード後の容量が一致しません`);
    mirror.items[m.itemId] = entry(m, key, hash, sourceEtag);
  }
  await rm(tmp); // ディスクを使い切らないよう、上げ終わったら消す
  return `[${upload ? 'ok' : 'dry-run'}] ${m.itemId}: ${(size / 1e6).toFixed(1)} MB sha256=${hash.slice(0, 12)}… ${((Date.now() - t0) / 1000).toFixed(1)} 秒`;
}

let next = 0;
let ok = 0;
let failed = 0;
async function worker() {
  while (next < targets.length) {
    const m = targets[next++];
    try {
      console.log(await mirrorOne(m));
      ok++;
    } catch (e) {
      failed++;
      console.error(`[error] ${m.itemId}: ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (upload) {
  mirror.baseUrl = publicBase + prefix;
  mirror.bucket = bucket;
  mirror.prefix = prefix;
  mirror.source = 'Flateau V2（https://source.coop/pacificspatial/flateau-2-0）を変換せずに複製';
  mirror.generatedAt = new Date().toISOString();
  await writeFile(MIRROR_JSON, JSON.stringify(mirror, null, 1));
}
console.log(`完了 ${ok} 件 / 失敗 ${failed} 件${dryRun ? '（dry-run）' : ''}`);
if (failed) process.exit(1);
