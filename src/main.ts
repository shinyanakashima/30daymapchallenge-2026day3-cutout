import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import maplibregl from 'maplibre-gl';
import { AnalysisClient } from './lib/analysis';
import {
  loadMaterials,
  loadPrefectures,
  loadTemplateFeature,
  loadTemplateIndex,
  materialLabel,
  materialPrefecture,
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
import type { CutoutStats, Placement, Res, Stage } from './worker/protocol';

// ---- 設定値（固定件数ではなく、処理量の目安） ----
const MAX_CANDIDATES = 80_000; // 取得矩形内の元の建物数がこれを超えたら確認を求める（間引きはしない）
const INITIAL_WIDTH_CAP = 4_000; // 初期幅の上限（m）。素材範囲に収まるよう、これ以下で自動設定
const PLINTH_M = 2; // 台座の厚み（m, 表示用）
const DEFAULT_MATERIAL = 'sapporo-shi-01100/building_lod0';
const DEFAULT_PREF = '01';
const DEFAULT_UNIT = '01202'; // 函館市

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => n.toLocaleString('ja-JP');
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} ms`);
const fmtBytes = (b: number | null) => (b == null ? '不明' : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`);

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
client.onFatal = (msg) => setStatus(msg, 'error');

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
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#f3f1ec' } },
      { id: 'gsi', type: 'raster', source: 'gsi', paint: { 'raster-opacity': 0.55, 'raster-saturation': -0.6 } },
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

function setMapStatus(s: string) {
  $('hud-map').textContent = `地図：${s}${tileErrors ? `（背景タイル取得エラー ${tileErrors} 件）` : ''}`;
}
map.on('error', (e) => {
  const msg = (e as { error?: Error }).error?.message ?? '不明';
  if ((e as { sourceId?: string }).sourceId === 'gsi' || /tile|cyberjapandata/i.test(msg)) tileErrors++;
  else setStatus(`地図のエラー：${msg}`, 'error');
  setMapStatus(mapLoaded ? '表示中' : '初期化中');
});
map.on('idle', () => {
  if (mapLoaded) setMapStatus(map.areTilesLoaded() ? '描画完了' : '描画中');
});
map.on('dataloading', () => mapLoaded && setMapStatus('描画中'));

const heightColor: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['coalesce', ['get', 'height_m'], 0],
  0, '#efe3c8', 8, '#e8bf86', 20, '#df8f4a', 45, '#c4521f', 90, '#8a2a14', 160, '#4a120a',
];
const colorModes: Record<string, maplibregl.ExpressionSpecification> = {
  height: ['case', ['==', ['get', 'height_m'], null], '#9aa0a6', heightColor],
  cut: ['case', ['==', ['get', 'height_m'], null], '#9aa0a6', ['case', ['get', 'cut'], '#c4521f', '#d9c6a3']],
  src: [
    'match', ['coalesce', ['get', 'height_src'], 'none'],
    'measured_height', '#3b6ea8', 'cal_height_m', '#d9a03f', '#9aa0a6',
  ],
};

map.on('load', () => {
  mapLoaded = true;
  setMapStatus('読込完了');
  map.addSource('coverage', { type: 'geojson', data: empty });
  map.addSource('cand', { type: 'geojson', data: empty });
  map.addSource('plinth', { type: 'geojson', data: empty });
  map.addSource('res', { type: 'geojson', data: empty });
  map.addSource('preview', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'coverage-line', type: 'line', source: 'coverage',
    paint: { 'line-color': '#335', 'line-width': 1.2, 'line-dasharray': [4, 3], 'line-opacity': 0.7 },
  });
  map.addLayer({
    id: 'cand-fill', type: 'fill', source: 'cand',
    paint: { 'fill-color': '#7d8590', 'fill-opacity': 0.28 },
  });
  map.addLayer({
    id: 'plinth', type: 'fill-extrusion', source: 'plinth',
    paint: { 'fill-extrusion-color': '#e9e4d8', 'fill-extrusion-opacity': 0.85, 'fill-extrusion-base': 0, 'fill-extrusion-height': PLINTH_M },
  });
  map.addLayer({
    id: 'res-3d', type: 'fill-extrusion', source: 'res',
    paint: { 'fill-extrusion-color': colorModes.height, 'fill-extrusion-opacity': 0.95, 'fill-extrusion-vertical-gradient': true },
  });
  map.addLayer({
    id: 'preview-fill', type: 'fill', source: 'preview',
    paint: { 'fill-color': '#d9661f', 'fill-opacity': 0.08 },
  });
  map.addLayer({
    id: 'preview-line', type: 'line', source: 'preview',
    paint: { 'line-color': '#d9661f', 'line-width': 2, 'line-dasharray': [2, 1.5] },
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
function setStatus(text: string, kind: 'busy' | 'ok' | 'error' | 'warn' | '' = '') {
  const el = $('job-status');
  el.textContent = text;
  el.className = `status ${kind}`;
}
function startBusy(label: () => string) {
  statusStart = performance.now();
  window.clearInterval(statusTimer);
  const tick = () => setStatus(`${label()}\n経過 ${fmtMs(performance.now() - statusStart)}`, 'busy');
  tick();
  statusTimer = window.setInterval(tick, 200);
}
function stopBusy() {
  window.clearInterval(statusTimer);
}
const STAGE_LABEL: Record<Stage, string> = {
  engine: '解析エンジン',
  material: '素材',
  template: '型',
  count: '候補数の確認',
  fetch: '候補取得',
  intersect: '切断',
  export: '出力',
  done: '完了',
};

function updateHud() {
  const m = state.material;
  $('hud-material').textContent = m
    ? `${materialLabel(m)} ／ ${m.itemId}${state.materialReady ? '' : '（準備中）'}`
    : '未選択';
  const u = state.unit;
  $('hud-template').textContent = u
    ? `${u.name}（${state.prefs.find((p) => p.code === state.prefCode)?.name ?? ''}・${u.code}）の行政界${state.templateReady ? '' : '（準備中）'}`
    : '未選択';
  const r = state.result;
  if (!r) $('hud-result').textContent = 'なし';
  else {
    const same = sameAsCurrentPlacement(r.placement);
    $('hud-result').textContent = `${fmt(r.stats.outputFeatures)} 件（型：${templateName(r.templateCode)}、建物：${
      state.materials.find((x) => x.id === r.materialId)?.areaJa?.replace('_', ' ') ?? r.materialId
    }）${same ? '' : ' ※前回の配置の結果'}`;
  }
}
function templateName(code: string) {
  return state.units.find((u) => u.code === code)?.name ?? code;
}

// ---- 素材 ----
function renderMaterialList() {
  const q = ($('material-filter') as HTMLInputElement).value.trim();
  const sel = $('material-select') as HTMLSelectElement;
  sel.innerHTML = '';
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const m of state.materials) {
    const label = materialLabel(m);
    if (q && !(`${label} ${m.itemId} ${m.title}`.includes(q))) continue;
    const pref = materialPrefecture(m);
    let g = groups.get(pref);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = pref;
      groups.set(pref, g);
      sel.appendChild(g);
    }
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${label}  ${m.rowCount != null ? fmt(m.rowCount) + '棟' : ''}`;
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
    ['素材', materialLabel(m)],
    ['データ年度', `${m.fiscalYear ?? '不明'}（${m.startDatetime?.slice(0, 10) ?? '?'} 〜 ${m.endDatetime?.slice(0, 10) ?? '?'}）`],
    ['建物数', m.rowCount != null ? `${fmt(m.rowCount)} 棟` : '不明'],
    ['容量', fmtBytes(m.fileSize)],
    ['範囲', m.bbox.map((v) => v.toFixed(4)).join(', ')],
    ['STAC Item', m.itemId],
    ['asset', `${m.asset}（${m.crs ?? 'CRS不明'}）`],
    ['解析CRS', state.materialEpsg ? `EPSG:${state.materialEpsg}（UTM ${state.materialEpsg - 32600}N）` : '-'],
  ];
  el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('') +
    `<dt>URL</dt><dd><a href="${m.href}" target="_blank" rel="noopener">parquet</a> / <a href="${m.itemHref}" target="_blank" rel="noopener">STAC</a>${
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

function clearResult(reason: string) {
  const had = !!state.result;
  state.result = null;
  if (mapLoaded) {
    src('res')?.setData(empty);
    src('plinth')?.setData(empty);
  }
  ($('btn-export') as HTMLButtonElement).disabled = true;
  $('job-stats').innerHTML = '';
  $('legend').innerHTML = '';
  if (had) setStatus(reason, '');
  updateHud();
}

async function selectMaterial(id: string) {
  const m = state.materials.find((x) => x.id === id);
  if (!m || state.material?.id === m.id) return;
  const seq = ++state.materialSeq;
  state.material = m;
  state.materialReady = false;
  state.materialEpsg = utmEpsg((m.bbox[0] + m.bbox[2]) / 2);
  state.denseCenter = null;
  // 旧素材の結果・候補は消す（別素材のデータを混ぜない）
  clearResult('素材を切り替えたため、前の結果を消去しました');
  state.candidatesFor = null;
  if (mapLoaded) src('cand')?.setData(empty);
  renderMaterialInfo();
  showCoverage();
  updateHud();
  setStatus(`素材を準備中：${materialLabel(m)}`, 'busy');
  try {
    const r = await client.request({
      type: 'setMaterial',
      material: { id: m.id, itemId: m.itemId, href: m.href, crs: m.crs ?? '', fiscalYear: m.fiscalYear, fileSize: m.fileSize },
      analysisEpsg: state.materialEpsg,
    });
    if (seq !== state.materialSeq) return; // より新しい選択がある
    if (r.type !== 'materialReady') return;
    state.materialReady = true;
    state.denseCenter = r.denseCenter;
    state.materialLoad = { ms: r.ms, transfer: r.transfer };
    setStatus(
      `素材の準備完了（${fmtMs(r.ms)}、取得 ${fmtBytes(r.transfer.bytes)}・${r.transfer.requests} 要求）。GEOM型：${r.geometryType}${r.hasBBoxColumns ? '' : '／bbox列なし'}`,
      'ok',
    );
    moveToMaterialCenter(true);
    renderMaterialInfo();
    updateHud();
  } catch (e) {
    if (seq !== state.materialSeq) return;
    setStatus(`素材の準備に失敗：${(e as Error).message}`, 'error');
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
    o.textContent = p.ready ? `${p.name}（${p.units}）` : `${p.name}（未整備）`;
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
    if (q && !`${u.name} ${u.code} ${u.group ?? ''}`.includes(q)) continue;
    const key = u.group ?? 'すべて';
    let g = groups.get(key);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = key;
      groups.set(key, g);
      sel.appendChild(g);
    }
    const o = document.createElement('option');
    o.value = u.code;
    const kind = u.kind === 'designated-city' ? '（市全体）' : u.kind === 'ward' ? '' : '';
    o.textContent = `${u.name}${kind}${u.parts > 1 ? `  ${u.parts}片` : ''}`;
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
  clearResult('型を切り替えたため、前の結果を消去しました');
  renderUnits();
  updateHud();
  $('template-info').textContent = '型を読込中…';
  try {
    const pp = state.prefCode;
    const f = await loadTemplateFeature(pp, code);
    if (seq !== state.templateSeq) return;
    const tg = prepareTemplate(f.geometry);
    state.tgeom = tg;
    drawThumb(f.geometry);
    const kindLabel = u.kind === 'designated-city' ? '政令指定都市（区を結合）' : u.kind === 'ward' ? '政令指定都市の区' : '市区町村';
    $('template-info').innerHTML =
      `<b>${escapeHtml(u.name)}</b>（${escapeHtml(state.prefs.find((p) => p.code === pp)?.name ?? '')}・${u.code}・${kindLabel}）<br>` +
      `元の大きさ：幅 ${(tg.w0 / 1000).toFixed(1)} km × 高さ ${(tg.h0 / 1000).toFixed(1)} km／${u.parts} 片（離島等を含む）／${fmt(u.vertices)} 頂点<br>` +
      `<span class="hint">この名前は型の形の出どころです。切り抜かれる建物は素材の街のものです。</span>`;
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
    $('template-info').textContent = `型の読込に失敗：${(e as Error).message}`;
  }
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
  const t = state.tgeom;
  if (!t || !state.material) {
    $('place-info').textContent = '';
    return;
  }
  const [lon, lat] = fromUtm(state.materialEpsg, state.tx, state.ty);
  const s = state.width / t.w0;
  $('place-info').innerHTML =
    `中心 ${lon.toFixed(5)}, ${lat.toFixed(5)}／倍率 ${s.toFixed(4)}（元の幅 ${(t.w0 / 1000).toFixed(1)} km → ${(state.width / 1000).toFixed(2)} km、高さ ${((t.h0 * s) / 1000).toFixed(2)} km）<br>` +
    `型の原点：型の外接矩形の中心／型CRS EPSG:${t.epsg} → 素材CRS EPSG:${state.materialEpsg}`;
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
    const h = p.height_m == null || p.height_m === 'null' ? '不明（0 m 扱いで表示）' : `${Number(p.height_m).toFixed(1)} m（${p.height_src}）`;
    new maplibregl.Popup({ maxWidth: '320px' })
      .setLngLat(e.lngLat)
      .setHTML(
        `<b>建物</b> ${escapeHtml(String(p.gml_id))}<br>高さ：${escapeHtml(h)}<br>` +
          `${p.cut === true || p.cut === 'true' ? '型の境界で切断' : '切断なし（型の内側）'}<br>` +
          `建物の出どころ：${escapeHtml(m ? materialLabel(m) : state.result.materialId)}<br>` +
          `型：${escapeHtml(templateName(state.result.templateCode))}（${state.result.templateCode}）`,
      )
      .addTo(map);
  });
  map.on('mouseenter', 'res-3d', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'res-3d', () => (map.getCanvas().style.cursor = ''));
}

// ---- 型抜き ----
async function runCutout(force: boolean) {
  if (!state.material || !state.materialReady || !state.tgeom || !state.templateReady || !state.unit) {
    setStatus('素材と型の準備が終わってから型抜きできます', 'warn');
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
    setStatus('型が素材の提供範囲（点線の矩形）の外にあります。素材の範囲内へ移動してください。', 'error');
    return;
  }
  const partial = !bboxContains(cover, placedLL);
  const size = Math.max(placed.bboxM.maxx - placed.bboxM.minx, placed.bboxM.maxy - placed.bboxM.miny);
  const fetchM = expandBBox(placed.bboxM, Math.max(200, size * 0.15));
  const fetchLL = bboxMToLonLat(E, fetchM);
  const jobId = ++state.jobSeq;
  state.activeJob = jobId;
  let stageText = '開始';
  startBusy(() => `型抜き中（${unit.name} × ${materialLabel(m)}）：${stageText}`);
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
        if (pr.type === 'progress') stageText = `${STAGE_LABEL[pr.stage]} — ${pr.message}`;
      },
    );
    stopBusy();
    if (r.type === 'needsConfirm') {
      setStatus(
        `取得矩形内の元の建物が目安の ${fmt(r.limit)} 件を超えました（${fmt(r.limit)} 件を超えた時点で読込を停止）。\n` +
          '型の幅を小さくするか、「このまま実行」を押してください（建物を間引くことはしません）。',
        'warn',
      );
      ($('btn-force') as HTMLButtonElement).hidden = false;
      $('job-stats').innerHTML =
        `判定までの所要時間：${r.timings.map((x) => `${STAGE_LABEL[x.stage]} ${fmtMs(x.ms)}${x.note ? `（${x.note}）` : ''}`).join(' / ')}<br>` +
        `素材の取得（実測）：${fmtBytes(r.transfer.bytes)}／${r.transfer.requests} 要求<br>` +
        (state.result ? '地図には前回の型抜き結果を表示しています。' : '');
      return;
    }
    if (r.type !== 'cutoutResult') return;
    // 古い計算結果で新しい選択を上書きしない
    if (r.materialId !== state.material?.id || r.templateCode !== state.unit?.code) {
      setStatus('素材または型が変わったため、古い計算結果を破棄しました', 'warn');
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
      src('plinth')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: placedForResult } });
    }
    ($('btn-export') as HTMLButtonElement).disabled = features.length === 0;
    renderStats(r.stats, partial);
    updateHud();
  } catch (e) {
    stopBusy();
    const err = e as Error & { stage?: Stage };
    setStatus(`型抜きに失敗（${err.stage ? STAGE_LABEL[err.stage] : '不明な段階'}）：${err.message}`, 'error');
  } finally {
    state.activeJob = 0;
    if (state.pendingCut) {
      state.pendingCut = false;
      void runCutout(false);
    }
  }
}

function renderStats(s: CutoutStats, partial: boolean) {
  const lines: string[] = [];
  let kind: 'ok' | 'warn' = 'ok';
  if (s.outputFeatures === 0) {
    kind = 'warn';
    lines.push(
      s.candidatesInCache === 0
        ? '取得矩形に建物がありません（素材の範囲内ですが、この場所には建物データがありません）。'
        : '型の内側に建物がありません。型を動かしてください。',
    );
  } else {
    lines.push(`型抜き完了：${fmt(s.outputFeatures)} 件（総計 ${fmtMs(s.totalMs)}${s.cacheHit ? '、候補はキャッシュを再利用' : ''}）`);
  }
  if (partial) {
    kind = 'warn';
    lines.push('型の一部が素材の提供範囲（点線）の外にあります。範囲外の部分には建物がありません。');
  }
  if (s.heightMissing > 0) lines.push(`高さ不明 ${fmt(s.heightMissing)} 件は 0 m 扱い（灰色の薄板）で表示しています。`);
  setStatus(lines.join('\n'), kind);
  const t = s.timings.map((x) => `${STAGE_LABEL[x.stage]} ${fmtMs(x.ms)}${x.note ? `（${x.note}）` : ''}`).join(' / ');
  $('job-stats').innerHTML =
    `元の建物（取得矩形・キャッシュ内）：${fmt(s.candidatesInCache)} 件・${fmt(s.candidateVertices)} 頂点<br>` +
    `型と交差：${fmt(s.candidatesTouching)} 件 → 切断なし ${fmt(s.wholeBuildings)}／境界で切断 ${fmt(s.cutBuildings)}／` +
    `複数片 ${fmt(s.multiPartFeatures)}／接するだけで除外 ${fmt(s.droppedEmpty)}／無効形状 ${fmt(s.invalidAfterFix)}<br>` +
    `所要時間：${t}<br>` +
    `素材の取得（実測）：${fmtBytes(s.transfer.bytes)}／${s.transfer.requests} 要求（部分取得 ${s.transfer.rangeRequests}・全体取得 ${s.transfer.fullRequests}${s.transfer.failed ? `・失敗 ${s.transfer.failed}` : ''}）`;
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
  $('ex-num').textContent = `${ex.toFixed(1)} 倍`;
  $('lift-num').textContent = `${lift} m`;
  if (!mapLoaded) return;
  const showPlinth = ($('show-plinth') as HTMLInputElement).checked;
  const base = lift + (showPlinth ? PLINTH_M : 0);
  map.setPaintProperty('res-3d', 'fill-extrusion-base', base);
  map.setPaintProperty('res-3d', 'fill-extrusion-height', [
    'case', ['==', ['get', 'height_m'], null], base + 0.3, ['+', base, ['*', ['to-number', ['get', 'height_m']], ex]],
  ]);
  map.setPaintProperty('plinth', 'fill-extrusion-base', lift);
  map.setPaintProperty('plinth', 'fill-extrusion-height', lift + PLINTH_M);
  map.setPaintProperty('res-3d', 'fill-extrusion-color', colorModes[($('color-mode') as HTMLSelectElement).value]);
  map.setLayoutProperty('plinth', 'visibility', showPlinth ? 'visible' : 'none');
  map.setLayoutProperty('cand-fill', 'visibility', ($('show-cand') as HTMLInputElement).checked ? 'visible' : 'none');
  const pv = ($('show-preview') as HTMLInputElement).checked ? 'visible' : 'none';
  map.setLayoutProperty('preview-fill', 'visibility', pv);
  map.setLayoutProperty('preview-line', 'visibility', pv);
  renderLegend();
}

function renderLegend() {
  const mode = ($('color-mode') as HTMLSelectElement).value;
  const sw = (c: string, t: string) => `<span class="item"><span class="sw" style="background:${c}"></span>${t}</span>`;
  const items =
    mode === 'height'
      ? [sw('#efe3c8', '0'), sw('#e8bf86', '8'), sw('#df8f4a', '20'), sw('#c4521f', '45'), sw('#8a2a14', '90'), sw('#4a120a', '160 m'), sw('#9aa0a6', '高さ不明')]
      : mode === 'cut'
        ? [sw('#d9c6a3', '切断なし'), sw('#c4521f', '境界で切断'), sw('#9aa0a6', '高さ不明')]
        : [sw('#3b6ea8', 'measured_height'), sw('#d9a03f', 'cal_height_m'), sw('#9aa0a6', 'なし（0 m 扱い）')];
  const { ex, lift } = viewParams();
  $('legend').innerHTML =
    items.join('') +
    `<br>${sw('rgba(125,133,144,0.28)', '元の建物（未切断）')}${sw('rgba(217,102,31,0.25)', '型のプレビュー')}${sw('#e9e4d8', '台座')}` +
    `<br>高さ倍率 ${ex.toFixed(1)} 倍・持ち上げ ${lift} m（表示のみ。出力の height_m は元の値）`;
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
    name: `まちの型抜き ${u?.name ?? r.templateCode} × ${materialLabel(m)}`,
    metadata: {
      generator: 'まちの型抜き（30DayMapChallenge 2026 Day 3）',
      createdAt: r.createdAt,
      crs: 'EPSG:4326 (lon, lat)',
      material: {
        id: m.id, stacItemId: m.itemId, stacItem: m.itemHref, asset: m.asset, href: m.href,
        title: m.titleJa ?? m.title, fiscalYear: m.fiscalYear, sourceCrs: m.crs,
      },
      template: {
        code: r.templateCode, name: u?.name ?? null, prefectureCode: state.prefCode, kind: u?.kind ?? null,
        source: '国土数値情報 行政区域データ N03-20260101', templateCrs: `EPSG:${state.tgeom?.epsg}`,
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
        '国土交通省 Project PLATEAU 3D都市モデル（CC BY 4.0）',
        'Pacific Spatial Solutions, Flateau V2（CC BY 4.0）',
        '「国土数値情報（行政区域データ）」（国土交通省）を加工して作成（CC BY 4.0）',
      ],
      processing: '建物フットプリント（LOD0）を、移動・拡縮・回転した行政界で切断（ST_Intersection）。境界をまたぐ建物は切断。',
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
  $('btn-force').addEventListener('click', () => void runCutout(true));
  for (const id of ['ex-range', 'lift-range', 'color-mode', 'show-cand', 'show-plinth', 'show-preview']) {
    $(id).addEventListener('input', updateViewPaint);
    $(id).addEventListener('change', updateViewPaint);
  }
  $('btn-export').addEventListener('click', exportGeoJSON);
}

async function boot() {
  wire();
  startBusy(() => 'カタログと解析エンジンを準備中');
  const initP = client.request({ type: 'init' }, (pr) => {
    if (pr.type === 'progress') $('engine-info').textContent = pr.message;
  });
  try {
    const [mats, prefs] = await Promise.all([loadMaterials(), loadPrefectures()]);
    state.materials = mats.materials;
    state.prefs = prefs.prefectures;
    renderMaterialList();
    renderPrefectures();
  } catch (e) {
    stopBusy();
    setStatus(`カタログの読込に失敗：${(e as Error).message}`, 'error');
    return;
  }
  try {
    const r = await initP;
    stopBusy();
    if (r.type === 'ready') {
      state.engineReady = true;
      $('engine-info').textContent = `解析エンジン：DuckDB-Wasm ${r.engineVersion} + spatial ${r.spatialVersion}（起動 ${fmtMs(r.ms)}）`;
      setStatus('解析エンジンの準備完了', 'ok');
    }
  } catch (e) {
    stopBusy();
    setStatus(`解析エンジンの起動に失敗：${(e as Error).message}`, 'error');
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
