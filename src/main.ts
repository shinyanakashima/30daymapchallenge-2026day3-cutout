import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import maplibregl from 'maplibre-gl';
import { AnalysisClient, WorkerError } from './lib/analysis';
import { applyStatic, lang, numberLocale, PREF_EN, PREF_JA, setLang, t } from './lib/i18n';
import {
  loadMaterials,
  loadMirrorCatalog,
  type MirrorCatalog,
  loadPrefectures,
  loadTemplateFeature,
  loadTemplateIndex,
  type Material,
  type PrefectureEntry,
  type TemplateUnit,
} from './lib/catalog';
import {
  affineCoefficients,
  bboxContains,
  bboxIntersects,
  bboxMToLonLat,
  bboxPolygon,
  expandBBox,
  fromUtm,
  placeTemplate,
  prepareTemplate,
  toUtm,
  utmEpsg,
  type MultiPoly,
  type TemplateGeom,
} from './lib/geo';
import type { CutoutStats, Msg, Placement, Res, Stage, StageTiming } from './worker/protocol';

// ---- 設定値（固定件数ではなく、処理量の目安） ----
const MAX_CANDIDATES = 80_000; // 取得矩形内の元の建物数がこれを超えたら確認を求める（間引きはしない）
const INITIAL_WIDTH_CAP = 4_000; // 初期幅の上限（m）。素材範囲に収まるよう、これ以下で自動設定
const PLINTH_M = 2; // 台座の厚み（m, 表示用）
const DEFAULT_MATERIAL = 'sapporo-shi-01100/building_lod0';
const DEFAULT_PREF = '01';
const DEFAULT_UNIT = '01202'; // 函館市

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => n.toLocaleString(numberLocale());
const fmtMs = (ms: number) => (ms >= 1000 ? t('s.sec', { n: (ms / 1000).toFixed(1) }) : t('s.ms', { n: Math.round(ms) }));
const fmtBytes = (b: number | null) => (b == null ? t('unknown') : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`);
/** Worker からの文言（キー＋値）を翻訳する。数値は桁区切り */
const tm = (m: Msg) =>
  t(m.k, m.p && Object.fromEntries(Object.entries(m.p).map(([k, v]) => [k, typeof v === 'number' ? fmt(v) : v])));
const stageLabel = (s?: string) => (s ? t(`stage.${s}`) : t('stage.unknown'));
const errText = (e: unknown) => (e instanceof WorkerError ? tm(e.msg) : e instanceof Error ? e.message : String(e));
const timingText = (ts: StageTiming[]) =>
  ts.map((x) => `${stageLabel(x.stage)} ${fmtMs(x.ms)}${x.note ? ` (${tm(x.note)})` : ''}`).join(' / ');

/** 都道府県名（言語別）。JA 名からコードを引く */
function prefName(code: string) {
  const i = Number(code) - 1;
  return lang === 'ja' ? PREF_JA[i] : PREF_EN[i];
}
function prefNameFromJa(ja: string) {
  const i = PREF_JA.indexOf(ja);
  return i < 0 ? ja : lang === 'ja' ? ja : PREF_EN[i];
}
/** STAC Item ID（例 sapporo-shi-01100）からローマ字の自治体名（Sapporo-shi）を作る */
function romajiFromItemId(itemId: string) {
  const slug = itemId.replace(/-\d{5}$/, '');
  return slug
    .split('-')
    .map((w, i, a) => (i === a.length - 1 && /^(shi|ku|cho|machi|mura|son|town|city)$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join('-')
    .replace(/-(shi|ku|cho|machi|mura|son)$/, '-$1');
}
function materialLabel(m: Material) {
  if (lang === 'ja') return `${m.areaJa ? m.areaJa.replace('_', ' ') : m.title}（${m.fiscalYear ?? t('unknown')}年度）`;
  return `${romajiFromItemId(m.itemId)}, ${prefNameFromJa(materialPrefectureJa(m))} (FY${m.fiscalYear ?? '?'})`;
}
function materialShort(m: Material) {
  return lang === 'ja' ? (m.areaJa?.split('_')[1] ?? m.title) : romajiFromItemId(m.itemId);
}
function materialPrefectureJa(m: Material) {
  return m.areaJa?.split('_')[0] ?? '';
}
/** 型の自治体名。英語表示ではローマ字が分かる場合（PLATEAU 対象都市）に併記する */
const romajiByJis = new Map<string, string>();
function unitName(u: { code: string; name: string }) {
  if (lang === 'ja') return u.name;
  const r = romajiByJis.get(u.code);
  return r ? `${r} ${u.name}` : u.name;
}

interface ResultState {
  fc: GeoJSON.FeatureCollection;
  materialId: string;
  templateCode: string;
  placement: Placement;
  placedLonLat: MultiPoly;
  stats: CutoutStats;
  createdAt: string;
}

const state = {
  engineReady: false,
  materials: [] as Material[],
  mirror: null as MirrorCatalog | null,
  material: null as Material | null,
  materialReady: false,
  materialEpsg: 0,
  denseCenter: null as [number, number] | null,
  materialLoad: null as null | { ms: number; transfer: import('./worker/protocol').Transfer },
  prefs: [] as PrefectureEntry[],
  prefCode: '',
  units: [] as TemplateUnit[],
  unit: null as TemplateUnit | null,
  tgeom: null as TemplateGeom | null,
  templateReady: false,
  tx: 0,
  ty: 0,
  width: 3000,
  rotation: 0,
  placedLonLat: null as MultiPoly | null,
  result: null as ResultState | null,
  candidatesFor: null as string | null, // 表示中の候補がどの素材のものか
  jobSeq: 0,
  activeJob: 0,
  pendingCut: false,
  forceNext: false,
  materialSeq: 0,
  templateSeq: 0,
};

// ---- 解析Worker ----
const client = new AnalysisClient();
client.onFatal = (msg) => setStatus(() => tm(msg), 'error');

// ---- 地図 ----
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      gsi: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">GSI Tiles</a>',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#08090b' } },
      // 淡色地図を明暗反転・無彩色にして暗い背景にする
      {
        id: 'gsi',
        type: 'raster',
        source: 'gsi',
        paint: {
          'raster-opacity': 0.42,
          'raster-saturation': -1,
          'raster-brightness-min': 1,
          'raster-brightness-max': 0,
          'raster-contrast': 0.15,
        },
      },
    ],
  },
  center: [141.3545, 43.0618],
  zoom: 12,
  pitch: 50,
  bearing: -15,
  maxPitch: 75,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
let mapLoaded = false;
let tileErrors = 0;

let mapStatusKey = 'map.init';
function setMapStatus(key: string) {
  mapStatusKey = key;
  $('hud-map').textContent = t(key) + (tileErrors ? t('map.tileErr', { n: tileErrors }) : '');
}
map.on('error', (e) => {
  const msg = (e as { error?: Error }).error?.message ?? '?';
  if ((e as { sourceId?: string }).sourceId === 'gsi' || /tile|cyberjapandata/i.test(msg)) tileErrors++;
  else setStatus(() => t('map.err', { msg }), 'error');
  setMapStatus(mapLoaded ? 'map.shown' : 'map.init');
});
map.on('idle', () => {
  if (mapLoaded) setMapStatus(map.areTilesLoaded() ? 'map.done' : 'map.drawing');
});
map.on('dataloading', () => mapLoaded && setMapStatus('map.drawing'));

// 建物は生地の色（高いほど焼き色が濃い）。刃（型の輪郭）だけが光る
const C = {
  nh: '#5c636c',
  ramp: [0, '#f4e2bd', 10, '#ecc282', 25, '#e19a4f', 50, '#c46c2c', 100, '#8e4318', 160, '#5a2a10'] as (number | string)[],
  whole: '#e8cfa0',
  cut: '#ffa94d',
  measured: '#8db8e3',
  cal: '#ecc282',
  cand: '#2b323b',
  blade: '#ffd08a',
  plinth: '#141619',
};
const heightColor = ['interpolate', ['linear'], ['coalesce', ['get', 'height_m'], 0], ...C.ramp] as unknown as maplibregl.ExpressionSpecification;
const colorModes: Record<string, maplibregl.ExpressionSpecification> = {
  height: ['case', ['==', ['get', 'height_m'], null], C.nh, heightColor],
  cut: ['case', ['==', ['get', 'height_m'], null], C.nh, ['case', ['get', 'cut'], C.cut, C.whole]],
  src: ['match', ['coalesce', ['get', 'height_src'], 'none'], 'measured_height', C.measured, 'cal_height_m', C.cal, C.nh],
};

map.on('load', () => {
  mapLoaded = true;
  setMapStatus('map.loaded');
  map.addSource('coverage', { type: 'geojson', data: empty });
  map.addSource('cand', { type: 'geojson', data: empty });
  map.addSource('plinth', { type: 'geojson', data: empty });
  map.addSource('res', { type: 'geojson', data: empty });
  map.addSource('preview', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'coverage-line', type: 'line', source: 'coverage',
    paint: { 'line-color': '#4b5563', 'line-width': 1.2, 'line-dasharray': [4, 3], 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'cand-fill', type: 'fill', source: 'cand',
    paint: { 'fill-color': C.cand, 'fill-opacity': 0.55 },
  });
  map.addLayer({
    id: 'plinth', type: 'fill-extrusion', source: 'plinth',
    paint: { 'fill-extrusion-color': C.plinth, 'fill-extrusion-opacity': 0.9, 'fill-extrusion-base': 0, 'fill-extrusion-height': PLINTH_M },
  });
  map.addLayer({
    id: 'res-3d', type: 'fill-extrusion', source: 'res',
    paint: { 'fill-extrusion-color': colorModes.height, 'fill-extrusion-opacity': 0.95, 'fill-extrusion-vertical-gradient': true },
  });
  map.addLayer({
    id: 'preview-fill', type: 'fill', source: 'preview',
    paint: { 'fill-color': '#ffb04d', 'fill-opacity': 0.03 },
  });
  // 光る刃：ぼかした太線 2 本の上に細い芯線
  map.addLayer({
    id: 'preview-glow-2', type: 'line', source: 'preview',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#ff8a1e', 'line-width': 16, 'line-blur': 14, 'line-opacity': 0.45 },
  });
  map.addLayer({
    id: 'preview-glow-1', type: 'line', source: 'preview',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#ffb052', 'line-width': 6, 'line-blur': 4, 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'preview-line', type: 'line', source: 'preview',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': C.blade, 'line-width': 1.6 },
  });
  updateViewPaint();
  setupDrag();
  setupPopup();
  if (state.material) showCoverage();
  renderPreview();
});

function src(id: string) {
  return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
}

// ---- 状態表示 ----
let statusTimer = 0;
let statusStart = 0;
type Kind = 'busy' | 'ok' | 'error' | 'warn' | '';
/** 状態表示。言語切替で作り直せるよう、文言は関数で受け取る */
let lastStatus: { text: () => string; kind: Kind } = { text: () => '', kind: '' };
function setStatus(text: () => string, kind: Kind = '') {
  lastStatus = { text, kind };
  const el = $('job-status');
  el.textContent = text();
  el.className = `status ${kind}`;
}
function startBusy(label: () => string) {
  statusStart = performance.now();
  window.clearInterval(statusTimer);
  const tick = () => setStatus(() => `${label()}\n${t('st.elapsed', { t: fmtMs(performance.now() - statusStart) })}`, 'busy');
  tick();
  statusTimer = window.setInterval(tick, 200);
}
function stopBusy() {
  window.clearInterval(statusTimer);
}

function updateHud() {
  const m = state.material;
  $('hud-material').textContent = m
    ? `${materialLabel(m)} / ${m.itemId}${state.materialReady ? '' : t('hud.preparing')}`
    : t('hud.none');
  const u = state.unit;
  $('hud-template').textContent = u
    ? t('hud.tpl', { name: unitName(u), pref: prefName(state.prefCode), code: u.code }) + (state.templateReady ? '' : t('hud.preparing'))
    : t('hud.none');
  const r = state.result;
  if (!r) $('hud-result').textContent = t('hud.noresult');
  else {
    const same = sameAsCurrentPlacement(r.placement);
    const mm = state.materials.find((x) => x.id === r.materialId);
    $('hud-result').textContent =
      t('hud.res', { n: fmt(r.stats.outputFeatures), tpl: templateName(r.templateCode), mat: mm ? materialShort(mm) : r.materialId }) +
      (same ? '' : t('hud.stale'));
  }
}
function templateName(code: string) {
  const u = state.units.find((x) => x.code === code);
  return u ? unitName(u) : code;
}

// ---- 素材 ----
function renderMaterialList() {
  const q = ($('material-filter') as HTMLInputElement).value.trim();
  const sel = $('material-select') as HTMLSelectElement;
  sel.innerHTML = '';
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const m of state.materials) {
    const label = materialLabel(m);
    if (q && !`${label} ${m.itemId} ${m.title} ${m.areaJa ?? ''}`.toLowerCase().includes(q.toLowerCase())) continue;
    const pref = prefNameFromJa(materialPrefectureJa(m));
    let g = groups.get(pref);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = pref;
      groups.set(pref, g);
      sel.appendChild(g);
    }
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${label}  ${m.rowCount != null ? t('material.count', { n: fmt(m.rowCount) }) : ''}`;
    if (state.material?.id === m.id) o.selected = true;
    g.appendChild(o);
  }
}

function renderMaterialInfo() {
  const m = state.material;
  const el = $('material-info');
  if (!m) {
    el.innerHTML = '';
    return;
  }
  const rows: [string, string][] = [
    [t('info.material'), materialLabel(m)],
    [t('info.year'), `${m.fiscalYear ?? t('unknown')} (${m.startDatetime?.slice(0, 10) ?? '?'} – ${m.endDatetime?.slice(0, 10) ?? '?'})`],
    [t('info.buildings'), m.rowCount != null ? t('info.buildingsN', { n: fmt(m.rowCount) }) : t('unknown')],
    [t('info.size'), fmtBytes(m.fileSize)],
    [t('info.extent'), m.bbox.map((v) => v.toFixed(4)).join(', ')],
    ['STAC Item', m.itemId],
    ['asset', `${m.asset} (${m.crs ?? '?'})`],
    [t('info.source'), useMirror(m) ? t('info.r2val', { size: fmtBytes(mirrorFor(m)!.bytes) }) : t('info.originval')],
    [t('info.crs'), state.materialEpsg ? `EPSG:${state.materialEpsg} (UTM ${state.materialEpsg - 32600}N)` : '-'],
  ];
  el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('') +
    `<dt>${t('info.links')}</dt><dd><a href="${m.href}" target="_blank" rel="noopener">parquet</a> / <a href="${m.itemHref}" target="_blank" rel="noopener">STAC</a>${
      m.sourcePage ? ` / <a href="${m.sourcePage}" target="_blank" rel="noopener">PLATEAU</a>` : ''
    }</dd>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function showCoverage() {
  const m = state.material;
  if (!mapLoaded || !m) return;
  const [x0, y0, x1, y1] = m.bbox;
  src('coverage')?.setData({
    type: 'Feature',
    properties: {},
    geometry: bboxPolygon({ minx: x0, miny: y0, maxx: x1, maxy: y1 }),
  });
}

function clearResult(reason: () => string) {
  const had = !!state.result;
  state.result = null;
  if (mapLoaded) {
    src('res')?.setData(empty);
    src('plinth')?.setData(empty);
  }
  ($('btn-export') as HTMLButtonElement).disabled = true;
  $('job-stats').innerHTML = '';
  lastStatsRender = null;
  $('legend').innerHTML = '';
  if (had) setStatus(reason, '');
  updateHud();
}

/** 取得元：R2 の複製（あれば既定）か公開元（source.coop） */
function mirrorFor(m: Material | null) {
  return m ? (state.mirror?.items[m.itemId] ?? null) : null;
}
function useMirror(m: Material | null) {
  return !!mirrorFor(m) && ($('source-select') as HTMLSelectElement).value === 'r2';
}
function syncSourceOptions() {
  const sel = $('source-select') as HTMLSelectElement;
  const opt = sel.querySelector('option[value="r2"]') as HTMLOptionElement;
  const mi = mirrorFor(state.material);
  opt.disabled = !mi;
  opt.textContent = mi ? t('source.r2') : t('source.r2none');
  if (!mi) sel.value = 'origin';
}

/** keepPlacement: 取得元の切替など、同じ素材を読み直すときは配置を保つ */
async function selectMaterial(id: string, reload = false, keepPlacement = false) {
  const m = state.materials.find((x) => x.id === id);
  if (!m || (!reload && state.material?.id === m.id)) return;
  if (!reload) {
    const sel = $('source-select') as HTMLSelectElement;
    if (mirrorFor(m)) sel.value = 'r2';
  }
  const seq = ++state.materialSeq;
  state.material = m;
  state.materialReady = false;
  state.materialEpsg = utmEpsg((m.bbox[0] + m.bbox[2]) / 2);
  state.denseCenter = null;
  // 旧素材の結果・候補は消す（別素材のデータを混ぜない）
  clearResult(() => t('st.clearedMat'));
  state.candidatesFor = null;
  if (mapLoaded) src('cand')?.setData(empty);
  syncSourceOptions();
  renderMaterialInfo();
  showCoverage();
  updateHud();
  const srcKey = useMirror(m) ? 'src.r2' : 'src.origin';
  setStatus(() => t('st.matPreparing', { name: materialLabel(m), src: t(srcKey) }), 'busy');
  try {
    const r = await client.request({
      type: 'setMaterial',
      material: {
        id: m.id,
        itemId: m.itemId,
        href: useMirror(m) ? mirrorFor(m)!.href : m.href,
        sourceHref: m.href,
        mirrorBaseUrl: useMirror(m) ? state.mirror!.baseUrl : null,
        crs: m.crs ?? '',
        fiscalYear: m.fiscalYear,
        fileSize: m.fileSize,
      },
      analysisEpsg: state.materialEpsg,
    });
    if (seq !== state.materialSeq) return; // より新しい選択がある
    if (r.type !== 'materialReady') return;
    state.materialReady = true;
    state.denseCenter = r.denseCenter;
    state.materialLoad = { ms: r.ms, transfer: r.transfer };
    setStatus(
      () =>
        t('st.matReady', {
          t: fmtMs(r.ms),
          b: fmtBytes(r.transfer.bytes),
          n: r.transfer.requests,
          g: r.geometryType,
          nb: r.hasBBoxColumns ? '' : t('st.noBBox'),
        }),
      'ok',
    );
    if (keepPlacement) scheduleAutoCut();
    else moveToMaterialCenter(true);
    renderMaterialInfo();
    updateHud();
  } catch (e) {
    if (seq !== state.materialSeq) return;
    setStatus(() => t('st.matFail', { msg: errText(e) }), 'error');
  }
}

function materialCenterLonLat(): [number, number] {
  const m = state.material!;
  if (state.denseCenter) return state.denseCenter;
  return [(m.bbox[0] + m.bbox[2]) / 2, (m.bbox[1] + m.bbox[3]) / 2];
}

function moveToMaterialCenter(fitWidth: boolean) {
  if (!state.material) return;
  const [lon, lat] = materialCenterLonLat();
  [state.tx, state.ty] = toUtm(state.materialEpsg, lon, lat);
  if (fitWidth) state.width = initialWidth();
  syncPlacementInputs();
  renderPreview();
  flyToPreview();
  scheduleAutoCut();
}

/** 素材の提供範囲に収まり、処理量が過大にならない初期幅（m） */
function initialWidth() {
  const m = state.material;
  const t = state.tgeom;
  if (!m || !t) return state.width;
  const E = state.materialEpsg;
  const [ax, ay] = toUtm(E, m.bbox[0], m.bbox[1]);
  const [bx, by] = toUtm(E, m.bbox[2], m.bbox[3]);
  const mw = Math.abs(bx - ax), mh = Math.abs(by - ay);
  const aspect = t.h0 / t.w0;
  const w = Math.min(mw * 0.5, (mh * 0.5) / aspect, INITIAL_WIDTH_CAP);
  return Math.max(200, Math.round(w / 50) * 50);
}

// ---- 型 ----
function renderPrefectures() {
  const sel = $('pref-select') as HTMLSelectElement;
  sel.innerHTML = '';
  for (const p of state.prefs) {
    const o = document.createElement('option');
    o.value = p.code;
    o.textContent = p.ready ? t('pref.ready', { name: prefName(p.code), n: p.units }) : t('pref.notReady', { name: prefName(p.code) });
    o.disabled = !p.ready;
    sel.appendChild(o);
  }
  sel.value = state.prefCode;
}

function renderUnits() {
  const q = ($('unit-filter') as HTMLInputElement).value.trim();
  const sel = $('unit-select') as HTMLSelectElement;
  sel.innerHTML = '';
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const u of state.units) {
    if (q && !`${unitName(u)} ${u.code} ${u.group ?? ''}`.toLowerCase().includes(q.toLowerCase())) continue;
    const key = u.group ?? t('unit.all');
    let g = groups.get(key);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = key;
      groups.set(key, g);
      sel.appendChild(g);
    }
    const o = document.createElement('option');
    o.value = u.code;
    const kind = u.kind === 'designated-city' ? t('unit.wholeCity') : '';
    o.textContent = `${unitName(u)}${kind}${u.parts > 1 ? `  ${t('unit.parts', { n: u.parts })}` : ''}`;
    if (state.unit?.code === u.code) o.selected = true;
    g.appendChild(o);
  }
}

async function selectPrefecture(pp: string, unitCode?: string) {
  const p = state.prefs.find((x) => x.code === pp);
  if (!p?.ready) return;
  state.prefCode = pp;
  ($('pref-select') as HTMLSelectElement).value = pp;
  const idx = await loadTemplateIndex(pp);
  if (state.prefCode !== pp) return;
  state.units = idx.units;
  ($('unit-filter') as HTMLInputElement).value = '';
  renderUnits();
  const target = unitCode && idx.units.find((u) => u.code === unitCode) ? unitCode : idx.units[0]?.code;
  if (target) await selectUnit(target);
}

async function selectUnit(code: string) {
  const u = state.units.find((x) => x.code === code);
  if (!u) return;
  const seq = ++state.templateSeq;
  state.unit = u;
  state.templateReady = false;
  state.tgeom = null;
  clearResult(() => t('st.clearedTpl'));
  renderUnits();
  updateHud();
  $('template-info').textContent = t('tpl.loading');
  try {
    const pp = state.prefCode;
    const f = await loadTemplateFeature(pp, code);
    if (seq !== state.templateSeq) return;
    const tg = prepareTemplate(f.geometry);
    state.tgeom = tg;
    drawThumb(f.geometry);
    renderTemplateInfo();
    const r = await client.request({
      type: 'setTemplate',
      code,
      name: u.name,
      geojson: JSON.stringify(f.geometry),
      templateEpsg: tg.epsg,
    });
    if (seq !== state.templateSeq) return;
    if (r.type !== 'templateReady') return;
    state.templateReady = true;
    state.width = initialWidth();
    syncPlacementInputs();
    renderPreview();
    updateHud();
    scheduleAutoCut();
  } catch (e) {
    if (seq !== state.templateSeq) return;
    $('template-info').textContent = t('tpl.failed', { msg: errText(e) });
  }
}

function renderTemplateInfo() {
  const u = state.unit;
  const tg = state.tgeom;
  if (!u || !tg) return;
  const kindLabel = t(u.kind === 'designated-city' ? 'kind.designated' : u.kind === 'ward' ? 'kind.ward' : 'kind.muni');
  $('template-info').innerHTML =
    `<b>${escapeHtml(unitName(u))}</b> (${escapeHtml(prefName(state.prefCode))} · ${u.code} · ${kindLabel})<br>` +
    t('tpl.size', { w: (tg.w0 / 1000).toFixed(1), h: (tg.h0 / 1000).toFixed(1), parts: fmt(u.parts), v: fmt(u.vertices) }) +
    `<br><span class="hint">${t('tpl.note')}</span>`;
}

function drawThumb(g: GeoJSON.Polygon | GeoJSON.MultiPolygon) {
  const mp = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const poly of mp) for (const [x, y] of poly[0]) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  const k = Math.cos((((miny + maxy) / 2) * Math.PI) / 180);
  const w = (maxx - minx) * k, h = maxy - miny;
  const s = 92 / Math.max(w, h);
  const ox = 50 - (w * s) / 2, oy = 50 - (h * s) / 2;
  const parts: string[] = [];
  for (const poly of mp) for (const ring of poly) {
    // サムネイル用に間引く（表示のみ。演算には使わない）
    const step = Math.max(1, Math.floor(ring.length / 400));
    const pts: string[] = [];
    for (let i = 0; i < ring.length; i += step) {
      const [x, y] = ring[i];
      pts.push(`${(ox + (x - minx) * k * s).toFixed(2)},${(oy + (maxy - y) * s).toFixed(2)}`);
    }
    parts.push(`M${pts.join('L')}Z`);
  }
  $('template-thumb').innerHTML = `<path fill-rule="evenodd" d="${parts.join('')}"/>`;
  $('cut-shape').innerHTML = `<path fill-rule="evenodd" d="${parts.join('')}"/>`;
}

// ---- 配置 ----
function currentPlacement(): Placement | null {
  const t = state.tgeom;
  if (!t) return null;
  return { cx: t.cx, cy: t.cy, w0: t.w0, width: state.width, rotationDeg: state.rotation, tx: state.tx, ty: state.ty };
}
function sameAsCurrentPlacement(p: Placement) {
  const c = currentPlacement();
  return !!c && Math.abs(c.tx - p.tx) < 1e-6 && Math.abs(c.ty - p.ty) < 1e-6 && c.width === p.width && c.rotationDeg === p.rotationDeg;
}

function syncPlacementInputs() {
  ($('width-range') as HTMLInputElement).value = String(Math.min(20000, state.width));
  ($('width-num') as HTMLInputElement).value = String(state.width);
  ($('rot-range') as HTMLInputElement).value = String(state.rotation);
  ($('rot-num') as HTMLInputElement).value = String(state.rotation);
  updatePlaceInfo();
}

function updatePlaceInfo() {
  const tg = state.tgeom;
  if (!tg || !state.material) {
    $('place-info').textContent = '';
    return;
  }
  const [lon, lat] = fromUtm(state.materialEpsg, state.tx, state.ty);
  const s = state.width / tg.w0;
  $('place-info').innerHTML = t('place.info', {
    lon: lon.toFixed(5),
    lat: lat.toFixed(5),
    s: s.toFixed(4),
    w0: (tg.w0 / 1000).toFixed(1),
    w: (state.width / 1000).toFixed(2),
    h: ((tg.h0 * s) / 1000).toFixed(2),
    a: tg.epsg,
    b: state.materialEpsg,
  });
}

let previewRaf = 0;
function renderPreview() {
  if (previewRaf) return;
  previewRaf = requestAnimationFrame(() => {
    previewRaf = 0;
    const p = currentPlacement();
    if (!mapLoaded || !p || !state.material || !state.materialReady) {
      if (mapLoaded) src('preview')?.setData(empty);
      return;
    }
    const placed = placeTemplate(state.tgeom!, p, state.materialEpsg);
    state.placedLonLat = placed.lonlat;
    src('preview')?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: placed.lonlat },
    });
    updatePlaceInfo();
    updateHud();
  });
}

function flyToPreview() {
  if (!mapLoaded || !state.tgeom || !state.material) return;
  const p = currentPlacement()!;
  const placed = placeTemplate(state.tgeom, p, state.materialEpsg);
  const ll = bboxMToLonLat(state.materialEpsg, placed.bboxM);
  map.fitBounds(
    [
      [ll.minx, ll.miny],
      [ll.maxx, ll.maxy],
    ],
    { padding: 80, pitch: 50, duration: 800 },
  );
}

let autoTimer = 0;
function scheduleAutoCut() {
  if (!($('auto-cut') as HTMLInputElement).checked) return;
  if (!state.materialReady || !state.templateReady) return;
  window.clearTimeout(autoTimer);
  autoTimer = window.setTimeout(() => void runCutout(false), 350);
}

function setupDrag() {
  let dragging = false;
  let start: { x: number; y: number; tx: number; ty: number } | null = null;
  const canvas = map.getCanvasContainer();
  map.on('mouseenter', 'preview-fill', () => {
    if (!dragging) canvas.style.cursor = 'move';
  });
  map.on('mouseleave', 'preview-fill', () => {
    if (!dragging) canvas.style.cursor = '';
  });
  const begin = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
    if (!state.tgeom || !state.material) return;
    if ('points' in e && e.points.length !== 1) return;
    e.preventDefault();
    dragging = true;
    canvas.style.cursor = 'grabbing';
    const [x, y] = toUtm(state.materialEpsg, e.lngLat.lng, e.lngLat.lat);
    start = { x, y, tx: state.tx, ty: state.ty };
    map.on('mousemove', move);
    map.on('touchmove', move);
    map.once('mouseup', end);
    map.once('touchend', end);
  };
  const move = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
    if (!dragging || !start) return;
    const [x, y] = toUtm(state.materialEpsg, e.lngLat.lng, e.lngLat.lat);
    state.tx = start.tx + (x - start.x);
    state.ty = start.ty + (y - start.y);
    renderPreview();
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = '';
    map.off('mousemove', move);
    map.off('touchmove', move);
    start = null;
    scheduleAutoCut();
  };
  map.on('mousedown', 'preview-fill', begin);
  map.on('touchstart', 'preview-fill', begin);
}

function setupPopup() {
  map.on('click', 'res-3d', (e) => {
    const f = e.features?.[0];
    if (!f || !state.result) return;
    const p = f.properties as Record<string, unknown>;
    const m = state.materials.find((x) => x.id === state.result!.materialId);
    const h = p.height_m == null || p.height_m === 'null' ? t('pp.hUnknown') : `${Number(p.height_m).toFixed(1)} m (${p.height_src})`;
    new maplibregl.Popup({ maxWidth: '320px' })
      .setLngLat(e.lngLat)
      .setHTML(
        `<b>${t('pp.building')}</b> ${escapeHtml(String(p.gml_id))}<br>${t('pp.height')}: ${escapeHtml(h)}<br>` +
          `${p.cut === true || p.cut === 'true' ? t('pp.cut') : t('pp.whole')}<br>` +
          `${t('pp.from')}: ${escapeHtml(m ? materialLabel(m) : state.result.materialId)}<br>` +
          `${t('pp.cutter')}: ${escapeHtml(templateName(state.result.templateCode))} (${state.result.templateCode})`,
      )
      .addTo(map);
  });
  map.on('mouseenter', 'res-3d', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'res-3d', () => (map.getCanvas().style.cursor = ''));
}

// ---- 型抜き ----
async function runCutout(force: boolean) {
  if (!state.material || !state.materialReady || !state.tgeom || !state.templateReady || !state.unit) {
    setStatus(() => t('st.notReady'), 'warn');
    return;
  }
  if (state.activeJob) {
    state.pendingCut = true; // 実行中の計算が終わったら最新の配置で1回だけ再計算
    return;
  }
  ($('btn-force') as HTMLButtonElement).hidden = true;
  const m = state.material;
  const unit = state.unit;
  const p = currentPlacement()!;
  const E = state.materialEpsg;
  const placed = placeTemplate(state.tgeom, p, E);
  const placedLL = bboxMToLonLat(E, placed.bboxM);
  const cover = { minx: m.bbox[0], miny: m.bbox[1], maxx: m.bbox[2], maxy: m.bbox[3] };
  if (!bboxIntersects(placedLL, cover)) {
    setStatus(() => t('st.outside'), 'error');
    return;
  }
  const partial = !bboxContains(cover, placedLL);
  const size = Math.max(placed.bboxM.maxx - placed.bboxM.minx, placed.bboxM.maxy - placed.bboxM.miny);
  const fetchM = expandBBox(placed.bboxM, Math.max(200, size * 0.15));
  const fetchLL = bboxMToLonLat(E, fetchM);
  const jobId = ++state.jobSeq;
  state.activeJob = jobId;
  let stageText = () => t('st.start');
  startBusy(() => t('st.cutting', { tpl: unitName(unit), mat: materialShort(m), stage: stageText() }));
  try {
    const r = await client.request(
      {
        type: 'cutout',
        jobId,
        materialId: m.id,
        templateCode: unit.code,
        placement: p,
        placedBBox: placed.bboxM,
        fetchBBoxLonLat: fetchLL,
        fetchBBoxM: fetchM,
        maxCandidates: MAX_CANDIDATES,
        readMode: ($('read-mode') as HTMLSelectElement).value === 'full' ? 'full' : 'range',
        force,
      },
      (pr: Res) => {
        if (pr.type === 'progress') stageText = () => `${stageLabel(pr.stage)} — ${tm(pr.msg)}`;
      },
    );
    stopBusy();
    if (r.type === 'needsConfirm') {
      setStatus(() => t('st.limit', { n: fmt(r.limit) }), 'warn');
      ($('btn-force') as HTMLButtonElement).hidden = false;
      const hadResult = !!state.result;
      lastStatsRender = () =>
        ($('job-stats').innerHTML =
          t('st.limitStats', { t: timingText(r.timings), b: fmtBytes(r.transfer.bytes), n: r.transfer.requests }) +
          (hadResult ? `<br>${t('st.prevShown')}` : ''));
      lastStatsRender();
      return;
    }
    if (r.type !== 'cutoutResult') return;
    // 古い計算結果で新しい選択を上書きしない
    if (r.materialId !== state.material?.id || r.templateCode !== state.unit?.code) {
      setStatus(() => t('st.stale'), 'warn');
      return;
    }
    const dec = new TextDecoder();
    const features = JSON.parse(dec.decode(r.result)) as GeoJSON.Feature[];
    if (r.candidates) {
      state.candidatesFor = r.materialId;
      if (mapLoaded) src('cand')?.setData(JSON.parse(dec.decode(r.candidates)));
    }
    const placedForResult = placeTemplate(state.tgeom!, r.placement, E).lonlat;
    state.result = {
      fc: { type: 'FeatureCollection', features },
      materialId: r.materialId,
      templateCode: r.templateCode,
      placement: r.placement,
      placedLonLat: placedForResult,
      stats: r.stats,
      createdAt: new Date().toISOString(),
    };
    if (mapLoaded) {
      src('res')?.setData(state.result.fc);
      stampAnimation();
      src('plinth')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: placedForResult } });
    }
    ($('btn-export') as HTMLButtonElement).disabled = features.length === 0;
    renderStats(r.stats, partial);
    updateHud();
  } catch (e) {
    stopBusy();
    const stage = e instanceof WorkerError ? (e.stage as Stage | undefined) : undefined;
    setStatus(() => t('st.cutFail', { stage: stageLabel(stage), msg: errText(e) }), 'error');
  } finally {
    state.activeJob = 0;
    if (state.pendingCut) {
      state.pendingCut = false;
      void runCutout(false);
    }
  }
}

let lastStatsRender: (() => void) | null = null;
function renderStats(s: CutoutStats, partial: boolean) {
  let kind: 'ok' | 'warn' = s.outputFeatures === 0 || partial ? 'warn' : 'ok';
  setStatus(() => {
    const lines: string[] = [];
    if (s.outputFeatures === 0) lines.push(t(s.candidatesInCache === 0 ? 'st.noBldArea' : 'st.noBldInside'));
    else lines.push(t('st.done', { n: fmt(s.outputFeatures), t: fmtMs(s.totalMs), cache: s.cacheHit ? t('st.cacheReuse') : '' }));
    if (partial) lines.push(t('st.partial'));
    if (s.heightMissing > 0) lines.push(t('st.hmiss', { n: fmt(s.heightMissing) }));
    return lines.join('\n');
  }, kind);
  lastStatsRender = () =>
    ($('job-stats').innerHTML =
      t('stats.cand', { n: fmt(s.candidatesInCache), v: fmt(s.candidateVertices) }) + '<br>' +
      t('stats.touch', {
        n: fmt(s.candidatesTouching), w: fmt(s.wholeBuildings), c: fmt(s.cutBuildings),
        m: fmt(s.multiPartFeatures), d: fmt(s.droppedEmpty), i: fmt(s.invalidAfterFix),
      }) + '<br>' +
      t('stats.time', { t: timingText(s.timings) }) + '<br>' +
      t('stats.transfer', {
        b: fmtBytes(s.transfer.bytes), n: s.transfer.requests, r: s.transfer.rangeRequests, f: s.transfer.fullRequests,
        fail: s.transfer.failed ? t('stats.failN', { n: s.transfer.failed }) : '',
      }));
  lastStatsRender();
  renderLegend();
}

// ---- 鑑賞 ----
function viewParams() {
  const ex = Number(($('ex-range') as HTMLInputElement).value);
  const lift = Number(($('lift-range') as HTMLInputElement).value);
  return { ex, lift };
}
function updateViewPaint() {
  const { ex, lift } = viewParams();
  $('ex-num').textContent = t('ex.val', { x: ex.toFixed(1) });
  $('lift-num').textContent = `${lift} m`;
  if (!mapLoaded) return;
  const showPlinth = ($('show-plinth') as HTMLInputElement).checked;
  const base = lift + (showPlinth ? PLINTH_M : 0);
  map.setPaintProperty('res-3d', 'fill-extrusion-base', base);
  setResultHeight(base, ex * riseFactor);
  map.setPaintProperty('plinth', 'fill-extrusion-base', lift);
  map.setPaintProperty('plinth', 'fill-extrusion-height', lift + PLINTH_M);
  map.setPaintProperty('res-3d', 'fill-extrusion-color', colorModes[($('color-mode') as HTMLSelectElement).value]);
  map.setLayoutProperty('plinth', 'visibility', showPlinth ? 'visible' : 'none');
  map.setLayoutProperty('cand-fill', 'visibility', ($('show-cand') as HTMLInputElement).checked ? 'visible' : 'none');
  const pv = ($('show-preview') as HTMLInputElement).checked ? 'visible' : 'none';
  for (const id of ['preview-fill', 'preview-glow-2', 'preview-glow-1', 'preview-line']) map.setLayoutProperty(id, 'visibility', pv);
  renderLegend();
}

function setResultHeight(base: number, ex: number) {
  map.setPaintProperty('res-3d', 'fill-extrusion-height', [
    'case', ['==', ['get', 'height_m'], null], base + 0.3, ['+', base, ['*', ['to-number', ['get', 'height_m']], ex]],
  ]);
}

/** 型抜きの演出：刃が一瞬強く光り、建物が平らな状態から立ち上がる（動きを減らす設定では省略） */
let riseFactor = 1;
let riseRaf = 0;
function stampAnimation() {
  if (!mapLoaded || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  cancelAnimationFrame(riseRaf);
  const btn = $('btn-cut');
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 140);
  const start = performance.now();
  const DUR = 750;
  const step = () => {
    const k = Math.min(1, (performance.now() - start) / DUR);
    const f = 1 - Math.pow(1 - k, 3);
    riseFactor = f;
    const { ex, lift } = viewParams();
    const base = lift + (($('show-plinth') as HTMLInputElement).checked ? PLINTH_M : 0);
    setResultHeight(base, ex * f);
    map.setPaintProperty('preview-glow-1', 'line-width', 6 + 10 * (1 - f));
    map.setPaintProperty('preview-glow-2', 'line-opacity', 0.45 + 0.45 * (1 - f));
    if (k < 1) riseRaf = requestAnimationFrame(step);
    else riseFactor = 1;
  };
  riseFactor = 0;
  step();
}

function renderLegend() {
  const mode = ($('color-mode') as HTMLSelectElement).value;
  const sw = (c: string, t: string) => `<span class="item"><span class="sw" style="background:${c}"></span>${t}</span>`;
  const items =
    mode === 'height'
      ? [0, 2, 4, 6, 8, 10].map((i) => sw(String(C.ramp[i + 1]), i === 10 ? `${C.ramp[i]} m` : String(C.ramp[i]))).concat(sw(C.nh, t('lg.nh')))
      : mode === 'cut'
        ? [sw(C.whole, t('lg.whole')), sw(C.cut, t('lg.cut')), sw(C.nh, t('lg.nh'))]
        : [sw(C.measured, 'measured_height'), sw(C.cal, 'cal_height_m'), sw(C.nh, t('lg.none0'))];
  const { ex, lift } = viewParams();
  $('legend').innerHTML =
    items.join('') +
    `<br>${sw(C.cand, t('lg.cand'))}${sw(C.blade, t('lg.preview'))}${sw(C.plinth, t('lg.plinth'))}` +
    `<br>${t('lg.note', { x: ex.toFixed(1), l: lift })}`;
}

// ---- 出力 ----
function exportGeoJSON() {
  const r = state.result;
  if (!r) return;
  const m = state.materials.find((x) => x.id === r.materialId)!;
  const u = state.units.find((x) => x.code === r.templateCode);
  const co = affineCoefficients(r.placement);
  const [lon, lat] = fromUtm(state.materialEpsg, r.placement.tx, r.placement.ty);
  const out = {
    type: 'FeatureCollection',
    name: `City Cutout ${u?.name ?? r.templateCode} × ${m.itemId}`,
    metadata: {
      generator: 'City Cutout / まちの型抜き (#30DayMapChallenge 2026 Day 3)',
      createdAt: r.createdAt,
      crs: 'EPSG:4326 (lon, lat)',
      material: {
        id: m.id, stacItemId: m.itemId, stacItem: m.itemHref, asset: m.asset, href: m.href,
        title: m.titleJa ?? m.title, fiscalYear: m.fiscalYear, sourceCrs: m.crs,
      },
      template: {
        code: r.templateCode, name: u?.name ?? null, prefectureCode: state.prefCode, kind: u?.kind ?? null,
        source: 'MLIT National Land Numerical Information, Administrative Areas N03-20260101', templateCrs: `EPSG:${state.tgeom?.epsg}`,
      },
      placement: {
        center_lonlat: [lon, lat], width_m: r.placement.width, rotation_deg_ccw: r.placement.rotationDeg,
        base_width_m: r.placement.w0, origin: 'template bbox center', origin_xy: [r.placement.cx, r.placement.cy],
        translate_xy: [r.placement.tx, r.placement.ty], analysis_crs: `EPSG:${state.materialEpsg}`,
        affine: { a: co.a, b: co.b, d: co.d, e: co.e, xoff: co.xoff, yoff: co.yoff },
      },
      heightRule: 'height_m = measured_height (>0) else cal_height_m (>0) else null',
      stats: r.stats,
      attribution: [
        'MLIT Project PLATEAU 3D city models (CC BY 4.0)',
        'Pacific Spatial Solutions, Flateau V2 (CC BY 4.0)',
        'National Land Numerical Information, Administrative Areas (MLIT, CC BY 4.0) — 「国土数値情報（行政区域データ）」（国土交通省）を加工して作成',
      ],
      processing: 'LOD0 building footprints cut (ST_Intersection) by the moved, scaled and rotated boundary; buildings crossing the boundary are split.',
    },
    features: r.fc.features.map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        material_id: r.materialId,
        template_code: r.templateCode,
        template_name: u?.name ?? null,
      },
    })),
  };
  const blob = new Blob([JSON.stringify(out)], { type: 'application/geo+json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cutout_${m.itemId}_${r.templateCode}.geojson`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

// ---- UI 結線 ----
function wire() {
  $('material-filter').addEventListener('input', renderMaterialList);
  $('material-select').addEventListener('change', (e) => void selectMaterial((e.target as HTMLSelectElement).value));
  $('pref-select').addEventListener('change', (e) => void selectPrefecture((e.target as HTMLSelectElement).value));
  $('unit-filter').addEventListener('input', renderUnits);
  $('unit-select').addEventListener('change', (e) => void selectUnit((e.target as HTMLSelectElement).value));

  const setWidth = (v: number, commit: boolean) => {
    if (!Number.isFinite(v) || v < 50) return;
    state.width = Math.min(200_000, Math.round(v));
    syncPlacementInputs();
    renderPreview();
    if (commit) scheduleAutoCut();
  };
  const setRot = (v: number, commit: boolean) => {
    if (!Number.isFinite(v)) return;
    state.rotation = Math.max(-180, Math.min(180, v));
    syncPlacementInputs();
    renderPreview();
    if (commit) scheduleAutoCut();
  };
  $('width-range').addEventListener('input', (e) => setWidth(Number((e.target as HTMLInputElement).value), false));
  $('width-range').addEventListener('change', (e) => setWidth(Number((e.target as HTMLInputElement).value), true));
  $('width-num').addEventListener('change', (e) => setWidth(Number((e.target as HTMLInputElement).value), true));
  $('rot-range').addEventListener('input', (e) => setRot(Number((e.target as HTMLInputElement).value), false));
  $('rot-range').addEventListener('change', (e) => setRot(Number((e.target as HTMLInputElement).value), true));
  $('rot-num').addEventListener('change', (e) => setRot(Number((e.target as HTMLInputElement).value), true));
  $('btn-center').addEventListener('click', () => moveToMaterialCenter(false));
  $('btn-fit').addEventListener('click', () => {
    state.width = initialWidth();
    syncPlacementInputs();
    renderPreview();
    flyToPreview();
    scheduleAutoCut();
  });
  $('btn-cut').addEventListener('click', () => void runCutout(false));
  $('source-select').addEventListener('change', () => {
    if (state.material) void selectMaterial(state.material.id, true, true);
  });
  $('btn-force').addEventListener('click', () => void runCutout(true));
  for (const id of ['ex-range', 'lift-range', 'color-mode', 'show-cand', 'show-plinth', 'show-preview']) {
    $(id).addEventListener('input', updateViewPaint);
    $(id).addEventListener('change', updateViewPaint);
  }
  $('btn-export').addEventListener('click', exportGeoJSON);
}

let engineInfo: (() => string) | null = null;

/** 言語を切り替え、表示中の文言をすべて作り直す */
function rerenderAll() {
  applyStatic();
  syncSourceOptions();
  renderMaterialList();
  renderMaterialInfo();
  renderPrefectures();
  renderUnits();
  renderTemplateInfo();
  updatePlaceInfo();
  updateViewPaint();
  lastStatsRender?.();
  setStatus(lastStatus.text, lastStatus.kind);
  setMapStatus(mapStatusKey);
  if (engineInfo) $('engine-info').textContent = engineInfo();
  updateHud();
}

async function boot() {
  applyStatic();
  setMapStatus('map.init');
  updateHud();
  updateViewPaint();
  wire();
  $('btn-lang').addEventListener('click', () => {
    setLang(lang === 'en' ? 'ja' : 'en');
    rerenderAll();
  });
  startBusy(() => t('st.boot'));
  const initP = client.request({ type: 'init' }, (pr) => {
    if (pr.type === 'progress') $('engine-info').textContent = tm(pr.msg);
  });
  try {
    const [mats, prefs, mirror] = await Promise.all([loadMaterials(), loadPrefectures(), loadMirrorCatalog()]);
    state.mirror = mirror;
    state.materials = mats.materials;
    for (const m of mats.materials) if (m.jisCode) romajiByJis.set(m.jisCode, romajiFromItemId(m.itemId));
    state.prefs = prefs.prefectures;
    renderMaterialList();
    renderPrefectures();
  } catch (e) {
    stopBusy();
    setStatus(() => t('st.catalogFail', { msg: errText(e) }), 'error');
    return;
  }
  try {
    const r = await initP;
    stopBusy();
    if (r.type === 'ready') {
      state.engineReady = true;
      engineInfo = () => t('engine.info', { v: r.engineVersion, s: r.spatialVersion, t: fmtMs(r.ms) });
      $('engine-info').textContent = engineInfo();
      setStatus(() => t('st.engineReady'), 'ok');
    }
  } catch (e) {
    stopBusy();
    setStatus(() => t('st.engineFail', { msg: errText(e) }), 'error');
    return;
  }
  const params = new URLSearchParams(location.search);
  const mat = params.get('material') ?? DEFAULT_MATERIAL;
  const pp = params.get('pref') ?? DEFAULT_PREF;
  const unit = params.get('template') ?? DEFAULT_UNIT;
  await Promise.all([
    selectMaterial(state.materials.some((m) => m.id === mat) ? mat : DEFAULT_MATERIAL),
    selectPrefecture(state.prefs.some((p) => p.code === pp && p.ready) ? pp : DEFAULT_PREF, unit),
  ]);
  renderMaterialList();
}

// 動作確認用（ブラウザのコンソールから状態を確認できる）
(window as unknown as { __cutout: unknown }).__cutout = { state, map };

void boot();
