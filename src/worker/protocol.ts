// 画面（main）と解析Worker の間でやり取りするメッセージ。
// Worker は任意SQL・任意URLを受け付けない。素材URLはカタログ由来、数値は検証してから使う。

export interface MaterialRef {
  id: string; // STAC Item ID + asset 名
  itemId: string;
  href: string; // building_lod0 asset の URL（カタログ由来）
  crs: string; // 例: EPSG:6668
  fiscalYear: number | null;
  fileSize: number | null;
}

/** 型の配置。座標は素材の解析CRS（m）。θ は度・反時計回り正 */
export interface Placement {
  cx: number; // 型の基準矩形中心（型ローカルCRS, m）
  cy: number;
  w0: number; // 型の基準幅（m）
  width: number; // 指定幅 W（m, 回転前）
  rotationDeg: number;
  tx: number; // 移動先（素材の解析CRS, m）
  ty: number;
}

export interface BBox {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

export type Req =
  | { type: 'init'; reqId: number }
  | { type: 'setMaterial'; reqId: number; material: MaterialRef; analysisEpsg: number }
  | {
      type: 'setTemplate';
      reqId: number;
      code: string;
      name: string;
      geojson: string; // Feature or Geometry, EPSG:6668 経緯度
      templateEpsg: number;
    }
  | {
      type: 'cutout';
      reqId: number;
      jobId: number;
      materialId: string;
      templateCode: string;
      placement: Placement;
      placedBBox: BBox; // 配置後の型の外接矩形（解析CRS, m）
      fetchBBoxLonLat: BBox; // 取得矩形（余白込み）の経緯度範囲
      fetchBBoxM: BBox; // 取得矩形（余白込み, 解析CRS, m）
      maxCandidates: number; // これを超えたら確認を求める（間引きはしない）
      readMode: 'range' | 'full';
      force: boolean;
    };

export type Stage =
  | 'engine'
  | 'material'
  | 'template'
  | 'count'
  | 'fetch'
  | 'intersect'
  | 'export'
  | 'done';

export interface StageTiming {
  stage: Stage;
  ms: number;
  note?: string;
}

/** DuckDB-Wasm が素材の取得に使った HTTP 要求の実測（素材ホストへの要求のみ） */
export interface Transfer {
  requests: number;
  bytes: number;
  rangeRequests: number; // 206 Partial Content
  fullRequests: number; // 200 の全体取得
  failed: number;
}

export interface CutoutStats {
  cacheHit: boolean;
  cacheBBoxM: BBox;
  candidatesInCache: number;
  candidateVertices: number;
  candidatesTouching: number; // 型と交差した元の建物数
  wholeBuildings: number; // 切断不要（型の内側）
  cutBuildings: number; // 境界で切断された建物
  outputFeatures: number;
  multiPartFeatures: number;
  invalidAfterFix: number;
  droppedEmpty: number;
  heightMissing: number;
  timings: StageTiming[];
  totalMs: number;
  transfer: Transfer; // この型抜きで発生した素材の取得
}

export type Res =
  | { type: 'progress'; reqId: number; jobId?: number; stage: Stage; message: string }
  | { type: 'error'; reqId: number; jobId?: number; stage: Stage; message: string }
  | { type: 'ready'; reqId: number; engineVersion: string; spatialVersion: string; ms: number }
  | {
      type: 'materialReady';
      reqId: number;
      materialId: string;
      columns: string[];
      hasBBoxColumns: boolean;
      geometryType: string;
      /** 行グループ統計から推定した建物の密な範囲の中心（経緯度）。推定できなければ null */
      denseCenter: [number, number] | null;
      transfer: Transfer;
      ms: number;
    }
  | { type: 'templateReady'; reqId: number; code: string; ms: number; vertices: number; parts: number }
  | {
      type: 'needsConfirm';
      reqId: number;
      jobId: number;
      candidates: number; // limit を超えた時点で読込を止めているため「limit+1 以上」を意味する
      limit: number;
      ms: number;
      timings: StageTiming[];
      transfer: Transfer;
    }
  | {
      type: 'cutoutResult';
      reqId: number;
      jobId: number;
      materialId: string;
      templateCode: string;
      placement: Placement;
      /** UTF-8 GeoJSON FeatureCollection（切り抜き結果, EPSG:4326） */
      result: ArrayBuffer;
      /** 新たに取得した候補（未切断の元の建物）。キャッシュ再利用時は null */
      candidates: ArrayBuffer | null;
      stats: CutoutStats;
    };
