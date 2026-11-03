# まちの型抜き（30DayMapChallenge 2026 / Day 3 Polygons）

選んだ街の建物（素材）を、別の自治体の行政界（型）で切り抜き、高さで押し出して3D表示します。
型の名前は「形の出どころ」で、切り抜かれる建物は素材の街のものです。
例：素材＝札幌市の建物ファイル、型＝函館市の行政界 → 札幌の建物が函館市の形に切り抜かれる。

利用者の流れ：素材ファイルを選ぶ → 都道府県・自治体から型を選ぶ → 配置（移動・幅・回転） → 型抜き → 鑑賞・GeoJSON出力。

## 起動

```bash
npm install
npm run dev       # http://localhost:5173/
npm run build     # 型チェック + dist/ へ出力
npm run preview   # http://localhost:4173/（ビルド結果の確認）
```

- 実行時に必要な外部アクセス：`data.source.coop`（素材の Parquet）、`extensions.duckdb.org`（DuckDB spatial 拡張）、`cyberjapandata.gsi.go.jp`（背景地図）。APIキー・個人情報は不要。
- `vite.config.ts` は `base: './'` のため、GitHub Pages 等のサブパスにそのまま置けます（配信先は未確定）。
- `dist/` には DuckDB-Wasm の wasm（約36MB/41MB）が含まれます。1ファイル100MB未満です。

## 構成

| 場所 | 役割 |
| --- | --- |
| `src/main.ts` | 画面・地図（MapLibre GL JS 5.24.0）、型のプレビューとドラッグ、状態管理、出力 |
| `src/worker/analysis.worker.ts` | 解析Worker。DuckDB-Wasm + spatial で候補取得・切断・GeoJSON化 |
| `src/worker/protocol.ts` | 画面と Worker のメッセージ定義 |
| `src/lib/geo.ts` | 配置の計算（Worker の `ST_Affine` と同じ式）、UTM 変換（proj4） |
| `src/lib/catalog.ts` | 素材・型カタログの読込 |
| `scripts/build-material-catalog.mjs` | STAC → `public/catalog/materials.json` |
| `scripts/build-templates.mjs` | N03 → `public/templates/`（ネイティブ DuckDB 1.5.6 + spatial） |
| `public/catalog/materials.json` | 素材一覧（303件、約0.3MB）。建物ファイル本体は含まない |
| `public/templates/` | 型の一覧と自治体ごとの行政界 GeoJSON（整備済み：北海道・東京都・大阪府・沖縄県） |

React は使っていません（Vite + TypeScript + MapLibre）。Python は不要です。

### データの区別

- 生データ：`data/raw/n03/*.zip`（`.gitignore` 対象。スクリプトが再取得）
- 配布用データ：`public/catalog/`、`public/templates/`（リポジトリに含める。小さなカタログ＋自治体ごとの型）
- キャッシュ：ブラウザのメモリ上のみ（DuckDB-Wasm 内の `cand` テーブル、全体取得時のファイルバッファ）。ディスクには書かない
- 素材の建物ファイル（Flateau V2 の Parquet）はリポジトリに含めず、実行時に取得元から読む

## データの取得・再生成

### 素材カタログ（Flateau V2 / STAC）

```bash
npm run data:materials
```

`https://data.source.coop/pacificspatial/flateau-2-0/flateau-v2-by-city/collection.json` の Item（303件）をたどり、
`building_lod0` asset を持つものだけを素材にします（重心・属性だけのファイルは含めない）。
表示名・年度・件数・容量・範囲は STAC のメタデータ（`plateau:area_ja`、`plateau:fiscal_year`、`table:row_count`、`file:size`、`bbox`）から取り、ファイル名から推測しません。
素材 ID は `<STAC Item ID>/building_lod0` で、同じ都市に複数年度が出ても Item ID で区別されます（2026-11-03 取得時点では同一 JIS コードの重複はなし）。

### 型（国土数値情報 N03 2026年）

```bash
npm run data:templates -- 01 13 27 47     # 都道府県コードを指定。zip が無ければ取得
```

- 入口：<https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html>
- 例：<https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2026/N03-20260101_01_GML.zip>（約66MB）
- zip 内の `N03-20260101_<pp>.geojson` を GDAL の `/vsizip/` で直接読みます（展開不要）。
- 行政区域コード `N03_007` ごとに、同じコードの地物だけを `ST_Union_Agg` → `ST_MakeValid`。別の自治体とは結合しません。
- 離島も同じ自治体の一部として残します（本島抽出はしません）。北海道は 194 コード＋札幌市全体＝195 件。
- 政令指定都市は区ごとの型に加え、区を結合した「市全体」も作ります（区コードの1の位を0にしたコード。例：01101〜01110 → 01100）。
- 座標は経緯度の小数6桁（約0.1m）に丸めます。形状の簡略化はしていません。サムネイルだけは表示用に頂点を間引きます。
- 未整備の都道府県は画面で「（未整備）」として選択不可になります。整備するには上のコマンドに都道府県コードを追加します。

各 `public/templates/<pp>/index.json` に出典URL・zip容量・元の地物数・CRS・処理エンジン・生成日時を記録しています。
素材側の容量・件数・CRS・年度・範囲は `public/catalog/materials.json` に記録しています。

## 解析の手順

解析 CRS：素材の範囲中心の経度から WGS84 UTM（`EPSG:326zz`、北半球）を選びます。札幌・千代田区は `EPSG:32654`。
型は型自身の中心経度の UTM で m 単位にし、配置後は素材の解析 CRS の平面上に置きます（別の街へ型を置くアート表現のため）。
EPSG:6668（JGD2011）の経緯度は `always_xy := true` で扱い、表示・出力は EPSG:4326 です。

配置（`src/lib/geo.ts` と Worker で同じ式）：
型の外接矩形中心 (cx, cy)、基準幅 W0、指定幅 W、倍率 s = W / W0、回転 θ（反時計回り正）、移動先 (tx, ty) として

```
a = s·cosθ, b = −s·sinθ, d = s·sinθ, e = s·cosθ
xoff = tx − a·cx − b·cy, yoff = ty − d·cx − e·cy
```

同じ自治体の MultiPolygon 全体に同じ `ST_Affine` をかけます。幅は回転前の値で、縦横比は保持されます。

Worker で実行する SQL の骨子（実際の文は `src/worker/analysis.worker.ts`）：

```sql
-- 1. 候補取得：配置後の型の外接矩形＋余白（15%、最低200m）に重なる元の建物を、切断前の形と高さのまま取得
CREATE TABLE cand AS
SELECT gml_id,
       CASE WHEN measured_height > 0 THEN measured_height
            WHEN cal_height_m   > 0 THEN cal_height_m END AS height_m,
       ST_Transform(GEOM, 'EPSG:6668', 'EPSG:<解析CRS>', always_xy := true) AS geom, ...
FROM read_parquet('<素材>')
WHERE cal_xmax >= :minx AND cal_xmin <= :maxx AND cal_ymax >= :miny AND cal_ymin <= :maxy
LIMIT 80001;   -- 8万件を超えたら止めて確認を求める（間引きはしない）

-- 2. 型の配置
CREATE TABLE placed AS SELECT ST_MakeValid(ST_Affine(g, a, b, d, e, xoff, yoff)) AS g FROM tpl;

-- 3. 型を小片に分割（外接矩形を長辺方向に二分する再帰。各片128頂点以下）
--    DuckDB-Wasm 版 spatial には ST_Subdivide が無いため自前で分割。小片の面積合計は元と一致（差 1e-6 m² 程度）
CREATE TABLE pieces AS WITH RECURSIVE sub(depth, g) AS (...) SELECT ...;

-- 4. 空間結合で交差判定し、小片ごとに切断して建物ごとに Union
CREATE TABLE hit AS
SELECT c.*, ST_Covers(p.g, c.geom) AS cov,
       CASE WHEN ST_Covers(p.g, c.geom) THEN NULL ELSE ST_Intersection(c.geom, p.g) END AS part
FROM cand c JOIN pieces p ON ST_Intersects(c.geom, p.g);

CREATE TABLE res AS
SELECT gml_id, height_m, bool_or(cov) AS whole,
       CASE WHEN bool_or(cov) THEN any_value(geom)
            ELSE ST_CollectionExtract(ST_MakeValid(ST_Union_Agg(part)), 3) END AS g
FROM hit GROUP BY gml_id
HAVING g IS NOT NULL AND NOT ST_IsEmpty(g) AND ST_Area(g) > 0;   -- 境界に接するだけの線・点は除外
```

型の分割は性能のためです。行政界（函館市で約2万頂点）との交差を1回ずつ行うとネイティブでも約19秒かかったのに対し、
小片＋空間結合では約0.05秒でした（ネイティブ DuckDB 1.5.6、10.7万候補）。分割版と直接交差の面積差は最大 2.7e-8 m²。

都道府県全体で先に建物を切る処理はありません。型選択（切断前の操作）→ 配置 → 型抜きの1段階です。

### 出力（GeoJSON）

- `FeatureCollection`（EPSG:4326）。`metadata` に素材（STAC Item ID・asset URL・年度）、型（コード・名前・出典）、配置（中心・幅・回転・原点・アフィン係数・解析CRS）、統計、出典を記録。
- 各地物：`result_id`（`素材ID:自治体コード:gml_id`）、`gml_id`、`height_m`（欠損は null）、`height_src`（`measured_height` / `cal_height_m` / null）、`cut`（境界で切断されたか）、`material_id`、`template_code`、`template_name`。
- 1つの建物が複数の非連結部分になる場合は MultiPolygon の1地物として出力します。単独の型では出力件数が型と交差した元の建物数と同じになることがあります。
- 高さ倍率・持ち上げ・台座は表示用で、出力の `height_m` は元の値です。

## 実測（2026-11-03、このリポジトリの開発環境）

計測環境：Linux コンテナ上の Headless Chromium 153（Playwright、SwiftShader）、外向き通信はプロキシ経由。
一般的な PC のブラウザとは回線の遅延・CPU が異なるため、絶対値は参考値です。転送量は DuckDB-Wasm の Worker が素材ホストに送った HTTP 要求を XHR ラッパーで数えた値（画面にも表示）です。

| 操作 | 結果 | 時間 | 素材の取得 |
| --- | --- | --- | --- |
| 解析エンジン起動（DuckDB-Wasm v1.5.4 + spatial） | | 3.3〜5.4秒 | 拡張 約6.9MB |
| 素材を選ぶ（札幌、ヘッダのみ） | スキーマ・行グループ統計 | 1.8〜3.5秒 | 26KB／3要求 |
| 札幌 × 函館市、幅4,000m、Range 読込 | 候補 53,440 → 出力 16,947（切断 1,755） | 計35〜39秒（うち取得33〜37秒） | 88.0MB／31〜40要求（206） |
| 同、ファイル全体取得モード | 同上 | 計9.5秒（うち取得6.7秒） | 92.4MB／1要求 |
| キャッシュ内の小さな移動 | 出力 16,950 | 1.3秒 | 0 |
| 回転35°（キャッシュ外へ） | 候補 45,471 → 16,398 | 13.6秒 | 26.6MB |
| 幅 2,500m に縮小 | 6,871 | 1.0秒 | 0 |
| 型を沖縄県 竹富町（169片の島）に変更 | 5,194 | 1.9秒 | 0（DuckDB 内の読込キャッシュ） |
| 素材を東京都 千代田区（2025年度）に変更 | 候補 6,396 → 286 | 15.1秒 | 6.5MB（ファイル 6.0MB） |
| 札幌で幅20,000m、上限超え → 「このまま実行」 | 候補 557,499 → 299,163 | 切断4.7秒・出力3.4秒 | — |

読み取れること：

- 素材を選んだだけでは建物ファイル本体は取得しません（ヘッダ26KB）。
- Flateau V2 の都市別ファイルは行グループが少なく（札幌は6個で各約10.8万棟）、各行グループが市内の広い範囲にまたがっています。
  そのため Range 読込でも取得量はファイル全体とほぼ同じになり、この環境では小さな要求を順に送る分だけ全体取得より遅くなりました。
  部分読込による高速化は、少なくとも札幌・千代田区のファイルでは確認できていません。画面で「ファイル全体を1回取得して保持」に切り替えられます。
- 型の切断自体は数万件で1秒前後。型を小片に分けない場合（DuckDB-Wasm で ST_Subdivide なし）は同条件で56秒でした。
- 2万パーツ程度は参考値で、保証上限ではありません。8万件を超える候補は確認を求め、件数を勝手に減らしません。

ブラウザでの確認範囲：開発サーバー（`npm run dev`）と `npm run preview` の両方で、地図・3D・解析 Worker の起動、型抜き、出力の再読込（Polygon/MultiPolygon のみ、空形状・ID重複なし）を Playwright で確認しました。
利用者の実ブラウザ（Windows Chrome 等）での目視確認は未実施です。

## 受入確認の対応状況

- 素材一覧は STAC Item の `building_lod0` asset と1対1。URL・Item ID・年度を画面と出力に表示。
- 素材切替で古い結果と候補を消去。素材ごとに別名でファイル登録し、キャッシュは素材ID・CRSが一致するときだけ再利用。結果IDは素材IDを含むため gml_id が衝突しない。
- 都道府県 → 自治体で型が1つに決まる。型の切替でも古い結果は消去。
- 型の外接矩形＋余白で候補を取得（キャッシュ）し、最終的な切断は行政界で行う。キャッシュ外へ出ると再取得し、取得量を表示。
- 素材の提供範囲（STAC bbox、点線）の外に型を置くとエラー、一部がはみ出すと警告。範囲内で建物が無い場合は別の文言で表示。
- 高さ欠損は null のまま出力し、表示では灰色の薄板（0m扱い）と明示。
- Worker の起動失敗・各段階のエラーを捕捉し、DuckDB-Wasm の起動は60秒、spatial 読込は90秒で打ち切ってエラー表示する。
- 計算中に新しい操作があれば、終わった後に最新の配置で1回だけ再計算。素材・型が変わった後に届いた古い結果は破棄。
- 地図はスタイル読込・タイル状態・エラーを HUD に表示（`idle` だけで完了扱いにしない）。

## 制約・未実装

- 型を整備済みなのは北海道・東京都・大阪府・沖縄県のみ（他は未整備表示）。追加は `npm run data:templates -- <pp>`。全47都道府県では約数百MBになる見込みで、配布方法は未検討。
- 素材の Range 読込は上記のとおり効果が小さい。Flateau V2 の KD-tree 分割コレクションの利用は未実装（別素材が混ざらないよう都市コードで絞る設計が必要）。
- 複数素材の合成、複数自治体の同時型抜き、都道府県全体のパズルは対象外（後続拡張）。
- 旧試作（184区域方式）の `data/buildings.geojson`、`data/cutters.geojson`、`day3-map-viewer.html`、`day3_work.duckdb` はこのリポジトリに含まれていません。再切り抜きにはそれらではなく、型の原本（N03）と切断前の建物（Flateau V2）を使います。
- JGD2011 と WGS84 は同一視して表示しています（差は数cm程度）。
- 背景地図（地理院タイル）が取得できない環境では背景なしで動作し、HUD にタイル取得エラー数を表示します。

## 出典・ライセンス

- 建物：国土交通省 Project PLATEAU 3D都市モデル（CC BY 4.0）を Pacific Spatial Solutions が GeoParquet 化した Flateau V2（<https://source.coop/pacificspatial/flateau-2-0>、CC BY 4.0）
- 型：「国土数値情報（行政区域データ）」（国土交通省）を加工して作成（N03-20260101、オープンデータ CC BY 4.0）
- 背景地図：地理院タイル（淡色地図）
- 加工内容：建物フットプリント（LOD0）を、移動・拡縮・回転した行政界で切断し、高さ属性で押し出して表示。行政界は同一コード内で結合し、座標を小数6桁に丸めています。
