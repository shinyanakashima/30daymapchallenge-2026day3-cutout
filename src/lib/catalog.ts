// 小さなカタログ（素材一覧・型一覧）の読み込み。大容量ファイルは選択するまで取得しない。

export interface Material {
  id: string;
  itemId: string;
  itemHref: string;
  asset: string;
  href: string;
  title: string;
  titleJa: string | null;
  areaJa: string | null;
  jisCode: string | null;
  fiscalYear: number | null;
  specVersion: string | null;
  datasetId: string | null;
  startDatetime: string | null;
  endDatetime: string | null;
  bbox: [number, number, number, number];
  fileSize: number | null;
  rowCount: number | null;
  geometryColumn: string | null;
  crs: string | null;
  sourcePage: string | null;
}

export interface MaterialCatalog {
  source: string;
  license: string;
  generatedAt: string;
  count: number;
  materials: Material[];
}

export interface PrefectureEntry {
  code: string;
  name: string;
  ready: boolean;
  units: number;
}

export interface TemplateUnit {
  code: string;
  name: string;
  kind: 'municipality' | 'ward' | 'designated-city';
  group: string | null;
  county: string | null;
  parts: number;
  vertices: number;
  srcFeatures: number;
  valid: boolean;
  bbox: [number, number, number, number];
  bytes: number;
}

export interface TemplateIndex {
  prefectureCode: string;
  prefecture: string;
  source: string;
  sourceUrl: string;
  units: TemplateUnit[];
}

const base = import.meta.env.BASE_URL;

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`);
  if (!r.ok) throw new Error(`${path} を取得できません（HTTP ${r.status}）`);
  return (await r.json()) as T;
}

export const loadMaterials = () => getJson<MaterialCatalog>('catalog/materials.json');
export const loadPrefectures = () =>
  getJson<{ source: string; prefectures: PrefectureEntry[] }>('templates/prefectures.json');
export const loadTemplateIndex = (pp: string) => getJson<TemplateIndex>(`templates/${pp}/index.json`);
export const loadTemplateFeature = (pp: string, code: string) =>
  getJson<GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>>(`templates/${pp}/${code}.geojson`);

export function materialLabel(m: Material) {
  const area = m.areaJa ? m.areaJa.replace('_', ' ') : m.title;
  return `${area}（${m.fiscalYear ?? '年度不明'}年度）`;
}
export function materialPrefecture(m: Material) {
  return m.areaJa?.split('_')[0] ?? 'その他';
}

/** R2 に変換せずに複製した素材の一覧（scripts/mirror-materials-to-r2.mjs が作成） */
export interface MirrorEntry {
  href: string;
  key: string;
  bytes: number | null;
  sha256: string | null;
  sourceHref: string;
  sourceEtag: string | null;
  uploadedAt: string;
}
export interface MirrorCatalog {
  baseUrl: string;
  generatedAt: string;
  items: Record<string, MirrorEntry>;
}
/** mirror.json が無い・読めない場合は null（公開元から読む） */
export async function loadMirrorCatalog(): Promise<MirrorCatalog | null> {
  try {
    const r = await fetch(`${base}catalog/mirror.json`);
    if (!r.ok) return null;
    const j = (await r.json()) as MirrorCatalog;
    return j && typeof j.baseUrl === 'string' && j.items ? j : null;
  } catch {
    return null;
  }
}
