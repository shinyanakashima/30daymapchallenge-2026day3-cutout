// Flateau V2 の STAC（都市別コレクション）から building_lod0 素材の一覧を作る。
// 生成物: public/catalog/materials.json（小さなカタログのみ。建物ファイル本体は取得しない）
// 使い方: node scripts/build-material-catalog.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const COLLECTION =
  'https://data.source.coop/pacificspatial/flateau-2-0/flateau-v2-by-city/collection.json';
const OUT = new URL('../public/catalog/materials.json', import.meta.url);

async function getJson(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    }
  }
}

const coll = await getJson(COLLECTION);
const itemLinks = coll.links.filter((l) => l.rel === 'item').map((l) => l.href);
console.log(`items in collection: ${itemLinks.length}`);

const materials = [];
const skipped = [];
let next = 0;
async function worker() {
  while (next < itemLinks.length) {
    const href = itemLinks[next++];
    const item = await getJson(href);
    const a = item.assets?.building_lod0;
    if (!a) {
      skipped.push({ id: item.id, reason: 'building_lod0 asset なし' });
      continue;
    }
    const p = item.properties ?? {};
    const via = (item.links ?? []).find((l) => l.rel === 'via' && l.type === 'text/html');
    materials.push({
      id: `${item.id}/building_lod0`,
      itemId: item.id,
      itemHref: href,
      asset: 'building_lod0',
      href: a.href,
      title: p.title ?? item.id,
      titleJa: p['plateau:title_ja'] ?? null,
      areaJa: p['plateau:area_ja'] ?? null,
      jisCode: p['plateau:jis_code'] ?? null,
      fiscalYear: p['plateau:fiscal_year'] ?? null,
      specVersion: p['plateau:spec_version'] ?? null,
      datasetId: p['plateau:dataset_id'] ?? null,
      startDatetime: p.start_datetime ?? null,
      endDatetime: p.end_datetime ?? null,
      bbox: item.bbox,
      fileSize: a['file:size'] ?? null,
      rowCount: a['table:row_count'] ?? null,
      geometryColumn: a['table:primary_geometry'] ?? null,
      crs: a['proj:code'] ?? null,
      sourcePage: via?.href ?? null,
    });
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
materials.sort((x, y) =>
  (x.jisCode ?? '').localeCompare(y.jisCode ?? '') || (x.fiscalYear ?? 0) - (y.fiscalYear ?? 0) || x.id.localeCompare(y.id),
);

await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify(
    {
      source: COLLECTION,
      license: coll.license,
      generatedAt: new Date().toISOString(),
      count: materials.length,
      skipped,
      materials,
    },
    null,
    0,
  ),
);
console.log(`materials: ${materials.length}, skipped: ${skipped.length}`);
