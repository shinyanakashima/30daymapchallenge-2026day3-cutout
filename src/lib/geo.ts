// 型の配置プレビュー用の幾何計算。Worker の ST_Affine と同じ式を使う。
import proj4 from 'proj4';
import type { BBox, Placement } from '../worker/protocol';

export type Ring = [number, number][];
export type Poly = Ring[];
export type MultiPoly = Poly[];

export function utmZone(lon: number) {
  return Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
}
/** 北半球 WGS84 UTM（EPSG:326zz）。日本の素材・型はすべて北半球 */
export function utmEpsg(lon: number) {
  return 32600 + utmZone(lon);
}

const converters = new Map<number, proj4.Converter>();
function conv(epsg: number) {
  let c = converters.get(epsg);
  if (!c) {
    const zone = epsg - 32600;
    c = proj4('EPSG:4326', `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`);
    converters.set(epsg, c);
  }
  return c;
}
export function toUtm(epsg: number, lon: number, lat: number): [number, number] {
  return conv(epsg).forward([lon, lat]) as [number, number];
}
export function fromUtm(epsg: number, x: number, y: number): [number, number] {
  return conv(epsg).inverse([x, y]) as [number, number];
}

export function geometryToMultiPoly(g: GeoJSON.Geometry): MultiPoly {
  if (g.type === 'Polygon') return [g.coordinates as Poly];
  if (g.type === 'MultiPolygon') return g.coordinates as MultiPoly;
  throw new Error(`未対応のジオメトリ: ${g.type}`);
}

export function bboxOfMulti(mp: MultiPoly): BBox {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const poly of mp) for (const ring of poly) for (const [x, y] of ring) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  return { minx, miny, maxx, maxy };
}

export interface TemplateGeom {
  epsg: number; // 型ローカルの解析CRS
  meters: MultiPoly; // 型ローカルCRSでの座標
  cx: number;
  cy: number;
  w0: number;
  h0: number;
  vertices: number;
  parts: number;
}

export function prepareTemplate(geom: GeoJSON.Geometry): TemplateGeom {
  const ll = geometryToMultiPoly(geom);
  const b = bboxOfMulti(ll);
  const epsg = utmEpsg((b.minx + b.maxx) / 2);
  let vertices = 0;
  const meters = ll.map((poly) =>
    poly.map((ring) =>
      ring.map(([lon, lat]) => {
        vertices++;
        return toUtm(epsg, lon, lat);
      }),
    ),
  );
  const mb = bboxOfMulti(meters);
  return {
    epsg,
    meters,
    cx: (mb.minx + mb.maxx) / 2,
    cy: (mb.miny + mb.maxy) / 2,
    w0: mb.maxx - mb.minx,
    h0: mb.maxy - mb.miny,
    vertices,
    parts: ll.length,
  };
}

export function affineCoefficients(p: Placement) {
  const s = p.width / p.w0;
  const th = (p.rotationDeg * Math.PI) / 180;
  const a = s * Math.cos(th), b = -s * Math.sin(th), d = s * Math.sin(th), e = s * Math.cos(th);
  return { a, b, d, e, xoff: p.tx - a * p.cx - b * p.cy, yoff: p.ty - d * p.cx - e * p.cy, scale: s };
}

/** 型を配置し、素材の解析CRS（m）と経緯度の両方で返す */
export function placeTemplate(t: TemplateGeom, p: Placement, materialEpsg: number) {
  const { a, b, d, e, xoff, yoff } = affineCoefficients(p);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const lonlat: MultiPoly = t.meters.map((poly) =>
    poly.map((ring) =>
      ring.map(([x, y]) => {
        const X = a * x + b * y + xoff;
        const Y = d * x + e * y + yoff;
        if (X < minx) minx = X;
        if (Y < miny) miny = Y;
        if (X > maxx) maxx = X;
        if (Y > maxy) maxy = Y;
        return fromUtm(materialEpsg, X, Y);
      }),
    ),
  );
  return { lonlat, bboxM: { minx, miny, maxx, maxy } as BBox };
}

export function expandBBox(b: BBox, margin: number): BBox {
  return { minx: b.minx - margin, miny: b.miny - margin, maxx: b.maxx + margin, maxy: b.maxy + margin };
}

/** UTM の矩形を辺を細かく区切って経緯度へ変換し、その外接矩形を返す */
export function bboxMToLonLat(epsg: number, b: BBox): BBox {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const fx = b.minx + ((b.maxx - b.minx) * i) / n;
    const fy = b.miny + ((b.maxy - b.miny) * i) / n;
    for (const [x, y] of [
      [fx, b.miny],
      [fx, b.maxy],
      [b.minx, fy],
      [b.maxx, fy],
    ] as [number, number][]) {
      const [lon, lat] = fromUtm(epsg, x, y);
      if (lon < minx) minx = lon;
      if (lat < miny) miny = lat;
      if (lon > maxx) maxx = lon;
      if (lat > maxy) maxy = lat;
    }
  }
  return { minx, miny, maxx, maxy };
}

export function bboxIntersects(a: BBox, b: BBox) {
  return a.minx <= b.maxx && a.maxx >= b.minx && a.miny <= b.maxy && a.maxy >= b.miny;
}
export function bboxContains(outer: BBox, inner: BBox) {
  return outer.minx <= inner.minx && outer.miny <= inner.miny && outer.maxx >= inner.maxx && outer.maxy >= inner.maxy;
}
export function bboxPolygon(b: BBox): GeoJSON.Polygon {
  return {
    type: 'Polygon',
    coordinates: [[[b.minx, b.miny], [b.maxx, b.miny], [b.maxx, b.maxy], [b.minx, b.maxy], [b.minx, b.miny]]],
  };
}
