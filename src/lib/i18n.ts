// 表示言語（既定は英語）。?lang=ja|en、または画面の切替ボタンで変更し、ブラウザに記憶する。

export type Lang = 'en' | 'ja';

type Dict = Record<string, string>;

const en: Dict = {
  'app.title': 'City Cutout',
  'app.sub': '#30DayMapChallenge 2026 · Day 3 — Polygons',
  'app.lead':
    "Cut one city's buildings with another municipality's boundary. The cutter's name says where the shape comes from; every building comes from the dough city.",
  'app.docTitle': 'City Cutout — #30DayMapChallenge 2026 Day 3 Polygons',
  'lang.switch': '日本語',

  'step1.title': 'Dough — building file',
  'step2.title': 'Cutter — prefecture → municipality',
  'step3.title': 'Place',
  'step4.title': 'Cut',
  'step5.title': 'View & export',

  'material.filter': 'Filter by city, prefecture or year',
  'material.count': '{n} bldgs',
  'source.label': 'Source',
  'source.r2': 'R2 mirror (geo-opendata)',
  'source.r2none': 'R2 mirror (not available for this file)',
  'source.origin': 'Publisher (source.coop)',

  'info.material': 'Dough',
  'info.year': 'Fiscal year',
  'info.buildings': 'Buildings',
  'info.size': 'File size',
  'info.extent': 'Extent',
  'info.source': 'Source',
  'info.crs': 'Analysis CRS',
  'info.links': 'Links',
  'info.buildingsN': '{n} buildings',
  'info.r2val': 'R2 mirror ({size}, byte-identical to the publisher file)',
  'info.originval': 'Publisher (source.coop)',
  unknown: 'unknown',

  'pref.label': 'Prefecture',
  'pref.ready': '{name} ({n})',
  'pref.notReady': '{name} (not prepared)',
  'unit.label': 'Municipality',
  'unit.filter': 'Filter municipalities',
  'unit.all': 'All',
  'unit.wholeCity': ' (whole city)',
  'unit.parts': '{n} parts',
  'tpl.loading': 'Loading the cutter…',
  'tpl.failed': 'Failed to load the cutter: {msg}',
  'kind.designated': 'designated city, wards merged',
  'kind.ward': 'ward of a designated city',
  'kind.muni': 'municipality',
  'tpl.size': 'Original size: {w} km × {h} km · {parts} parts (islands included) · {v} vertices',
  'tpl.note': 'The name tells where the shape comes from. The buildings that get cut belong to the dough city.',
  'thumb.aria': 'Outline of the selected cutter',

  'place.hint': 'Drag the orange outline on the map to move the cutter.',
  'place.width': 'Width (before rotation, m)',
  'place.rot': 'Rotation (°, counter-clockwise)',
  'place.center': 'Back to the dense area',
  'place.fit': 'Default size',
  'place.info':
    'Center {lon}, {lat} · scale {s} (width {w0} km → {w} km, height {h} km)<br>Origin: center of the cutter’s bounding box · cutter CRS EPSG:{a} → dough CRS EPSG:{b}',

  'cut.auto': 'Cut automatically after each adjustment',
  'cut.read': 'Loading',
  'read.full': 'Whole file once (kept in memory)',
  'read.range': 'Only needed parts (HTTP Range)',
  'cut.readHint':
    'Default is the whole file. Flateau V2 city files have large row groups, so ranged reads fetch almost the whole file anyway and take longer (measured values appear below).',
  'cut.btn': 'Cut',
  'cut.force': 'Run anyway',

  'view.ex': 'Height ×',
  'view.lift': 'Lift',
  'view.color': 'Color by',
  'color.height': 'Height',
  'color.cut': 'Cut / whole',
  'color.src': 'Height source',
  'view.cand': 'Show uncut buildings (candidates)',
  'view.plinth': 'Show base',
  'view.preview': 'Show cutter outline',
  'view.export': 'Export GeoJSON',
  'ex.val': '{x}×',

  'credits.title': 'Data & processing',
  'credits.html':
    '<li>Buildings: MLIT Project <a href="https://www.mlit.go.jp/plateau/" target="_blank" rel="noopener">PLATEAU</a> 3D city models, converted to <a href="https://source.coop/pacificspatial/flateau-2-0" target="_blank" rel="noopener">Flateau V2</a> by Pacific Spatial Solutions (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>). Served from a byte-identical mirror on Cloudflare R2.</li>' +
    '<li>Cutters: <a href="https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html" target="_blank" rel="noopener">National Land Numerical Information, Administrative Areas (N03, 2026)</a>, MLIT, CC BY 4.0. Processed from 「国土数値情報（行政区域データ）」（国土交通省）.</li>' +
    '<li>Basemap: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">GSI Tiles (pale)</a></li>' +
    '<li>Processing: building footprints are cut with the moved, scaled and rotated boundary and extruded by height. Boundaries are merged within each code; coordinates rounded to 6 decimals.</li>',

  'hud.dough': 'Dough',
  'hud.cutter': 'Cutter',
  'hud.result': 'Result',
  'hud.none': 'not selected',
  'hud.noresult': 'none',
  'hud.preparing': ' (preparing)',
  'hud.tpl': '{name} ({pref} · {code}) boundary',
  'hud.res': '{n} pieces (cutter: {tpl}, buildings: {mat})',
  'hud.stale': ' · from the previous placement',

  'map.init': 'Map: initializing',
  'map.loaded': 'Map: loaded',
  'map.drawing': 'Map: rendering',
  'map.done': 'Map: rendered',
  'map.shown': 'Map: shown',
  'map.tileErr': ' ({n} basemap tile errors)',
  'map.err': 'Map error: {msg}',

  'stage.engine': 'Engine',
  'stage.material': 'Dough',
  'stage.template': 'Cutter',
  'stage.count': 'Counting',
  'stage.fetch': 'Fetch',
  'stage.intersect': 'Cut',
  'stage.export': 'Export',
  'stage.done': 'Done',
  'stage.unknown': 'unknown stage',

  'st.elapsed': 'elapsed {t}',
  'st.boot': 'Loading catalogs and the analysis engine',
  'st.catalogFail': 'Failed to load catalogs: {msg}',
  'st.engineReady': 'Analysis engine ready',
  'st.engineFail': 'The analysis engine failed to start: {msg}',
  'engine.info': 'Engine: DuckDB-Wasm {v} + spatial {s} (started in {t})',
  'st.matPreparing': 'Preparing dough: {name} (source: {src})',
  'src.r2': 'R2 mirror',
  'src.origin': 'source.coop',
  'st.matReady': 'Dough ready ({t}, fetched {b}, requests: {n}). GEOM type: {g}{nb}',
  'st.noBBox': ' / no bbox columns',
  'st.matFail': 'Failed to prepare the dough: {msg}',
  'st.clearedMat': 'Dough changed — previous result cleared',
  'st.clearedTpl': 'Cutter changed — previous result cleared',
  'st.notReady': 'Wait until both the dough and the cutter are ready',
  'st.outside': 'The cutter is outside the dough’s coverage (dashed rectangle). Move it inside.',
  'st.cutting': 'Cutting {tpl} × {mat}: {stage}',
  'st.start': 'starting',
  'st.limit':
    'More than {n} buildings in the fetch area (reading stopped at {n}).\nMake the cutter smaller or press “Run anyway”. No buildings are dropped.',
  'st.limitStats': 'Time until stop: {t}<br>Dough fetched (measured): {b}, requests: {n}',
  'st.prevShown': 'The map still shows the previous result.',
  'st.stale': 'The dough or cutter changed — an outdated result was discarded',
  'st.cutFail': 'Cut failed ({stage}): {msg}',
  'st.noBldArea': 'No buildings in the fetch area (inside the coverage, but there is no building data here).',
  'st.noBldInside': 'No buildings inside the cutter. Move it.',
  'st.done': 'Cut: {n} pieces (total {t}{cache})',
  'st.cacheReuse': ', candidates reused from cache',
  'st.partial': 'Part of the cutter is outside the dough’s coverage (dashed). There are no buildings there.',
  'st.hmiss': '{n} buildings without height are shown as 0 m (thin grey slabs).',
  'st.workerFatal': 'The analysis worker failed: {msg}',
  'st.workerMsg': 'Could not read a message from the analysis worker',

  'stats.cand': 'Uncut buildings in the fetch area (cache): {n} · {v} vertices',
  'stats.touch':
    'Touching the cutter: {n} → whole {w} · cut at the edge {c} · multi-part {m} · touching only (dropped) {d} · invalid {i}',
  'stats.time': 'Time: {t}',
  'stats.transfer': 'Dough fetched (measured): {b}, requests: {n} (ranged {r} · whole {f}{fail})',
  'stats.failN': ' · failed {n}',

  'lg.nh': 'no height',
  'lg.whole': 'whole',
  'lg.cut': 'cut at the edge',
  'lg.none0': 'none (0 m)',
  'lg.cand': 'uncut buildings',
  'lg.preview': 'cutter',
  'lg.plinth': 'base',
  'lg.note': 'Height × {x}, lift {l} m (display only; exported height_m is unchanged)',

  'pp.building': 'Building',
  'pp.height': 'Height',
  'pp.hUnknown': 'unknown (shown as 0 m)',
  'pp.cut': 'Cut at the cutter’s edge',
  'pp.whole': 'Not cut (inside the cutter)',
  'pp.from': 'Buildings from',
  'pp.cutter': 'Cutter',

  's.sec': '{n} s',
  's.ms': '{n} ms',

  'w.starting': 'Starting DuckDB-Wasm',
  'w.spatial': 'Loading the spatial extension ({v})',
  'w.schema': 'Reading the schema (header only)',
  'w.tplProject': 'Projecting the cutter',
  'w.fetchWhole': 'Downloading the whole dough file ({mb} MB)',
  'w.fetchWholeProg': 'Downloading the whole dough file {got} / {total} MB',
  'w.fetchCand': 'Fetching and projecting buildings in the fetch area',
  'w.cutting': 'Placing the cutter and cutting',
  'w.export': 'Converting to GeoJSON',
  'n.whole': 'whole file {mb} MB kept in memory',
  'n.overLimit': 'stopped above {n}',
  'n.cand': '{n} bldgs / {v} vertices',
  'n.candGeo': 'candidate GeoJSON',
  'n.pieces': 'cutter split into {n} pieces',
  'n.out': '{n} pieces',
  'e.raw': '{text}',
  'e.badNum': 'Invalid number: {name}',
  'e.badCrs': 'Analysis CRS not allowed: {n}',
  'e.badRange': 'Invalid extent: {name}',
  'e.noDb': 'DuckDB is not initialized',
  'e.dbWorker': 'DuckDB worker error: {msg}',
  'e.timeoutStart': 'DuckDB-Wasm did not start within 60 seconds',
  'e.timeoutSpatial': 'The spatial extension did not load within 90 seconds',
  'e.badUrl': 'The dough URL does not match the catalog format',
  'e.badMirror': 'The R2 mirror URL does not match the catalog location',
  'e.mirrorName': 'The R2 mirror file name differs from the publisher file',
  'e.urlMismatch': 'The dough URL differs from the publisher URL',
  'e.crs': 'Unsupported dough CRS: {crs}',
  'e.col': 'The dough file is missing a required column: {c}',
  'e.code': 'Invalid municipality code',
  'e.gj': 'Could not parse the cutter GeoJSON',
  'e.geomType': 'The cutter must be a Polygon or MultiPolygon',
  'e.download': 'Could not download the dough file (HTTP {s})',
  'e.matMismatch': 'The dough does not match the current selection (select it again)',
  'e.tplMismatch': 'The cutter does not match the current selection (select it again)',
  'e.width': 'Invalid width',
};

const ja: Dict = {
  'app.title': 'まちの型抜き',
  'app.sub': '#30DayMapChallenge 2026 · Day 3 — Polygons',
  'app.lead': '選んだ街の建物を、別の自治体の行政界で型抜きします。型の名前は形の出どころで、建物は素材の街のものです。',
  'app.docTitle': 'まちの型抜き — 30DayMapChallenge 2026 Day 3 Polygons',
  'lang.switch': 'English',

  'step1.title': '素材を選ぶ（建物ファイル）',
  'step2.title': '型を選ぶ（都道府県 → 自治体）',
  'step3.title': '配置',
  'step4.title': '型抜き',
  'step5.title': '鑑賞・出力',

  'material.filter': '都市名・都道府県・年度で絞り込み',
  'material.count': '{n}棟',
  'source.label': '取得元',
  'source.r2': 'R2 の複製（geo-opendata）',
  'source.r2none': 'R2 の複製（この素材は未登録）',
  'source.origin': '公開元（source.coop）',

  'info.material': '素材',
  'info.year': 'データ年度',
  'info.buildings': '建物数',
  'info.size': '容量',
  'info.extent': '範囲',
  'info.source': '取得元',
  'info.crs': '解析CRS',
  'info.links': 'URL',
  'info.buildingsN': '{n} 棟',
  'info.r2val': 'R2 の複製（{size}、公開元と同一ファイル）',
  'info.originval': '公開元 source.coop',
  unknown: '不明',

  'pref.label': '型の都道府県',
  'pref.ready': '{name}（{n}）',
  'pref.notReady': '{name}（未整備）',
  'unit.label': '型の自治体',
  'unit.filter': '自治体名で絞り込み',
  'unit.all': 'すべて',
  'unit.wholeCity': '（市全体）',
  'unit.parts': '{n}片',
  'tpl.loading': '型を読込中…',
  'tpl.failed': '型の読込に失敗：{msg}',
  'kind.designated': '政令指定都市（区を結合）',
  'kind.ward': '政令指定都市の区',
  'kind.muni': '市区町村',
  'tpl.size': '元の大きさ：幅 {w} km × 高さ {h} km／{parts} 片（離島等を含む）／{v} 頂点',
  'tpl.note': 'この名前は型の形の出どころです。切り抜かれる建物は素材の街のものです。',
  'thumb.aria': '選択中の型の輪郭',

  'place.hint': '地図上の型（オレンジの輪郭）をドラッグして移動します。',
  'place.width': '幅（回転前, m）',
  'place.rot': '回転（度, 反時計回り）',
  'place.center': '素材の密な範囲へ戻す',
  'place.fit': '初期サイズ',
  'place.info':
    '中心 {lon}, {lat}／倍率 {s}（元の幅 {w0} km → {w} km、高さ {h} km）<br>型の原点：型の外接矩形の中心／型CRS EPSG:{a} → 素材CRS EPSG:{b}',

  'cut.auto': '配置の操作を終えたら自動で型抜き',
  'cut.read': '素材の読込',
  'read.full': 'ファイル全体を1回取得して保持',
  'read.range': '必要な部分だけ取得（HTTP Range）',
  'cut.readHint':
    '既定は「全体を1回取得」です。Flateau V2 の都市別ファイルは行グループが大きく、部分取得でもほぼ全体を読むため、1回で取る方が速く済みます（実測値は下に表示）。',
  'cut.btn': '型抜き',
  'cut.force': 'このまま実行',

  'view.ex': '高さ倍率',
  'view.lift': '持ち上げ量',
  'view.color': '色分け',
  'color.height': '高さ',
  'color.cut': '切断の有無',
  'color.src': '高さの出典',
  'view.cand': '元の建物（未切断の候補）を表示',
  'view.plinth': '台座を表示',
  'view.preview': '型のプレビューを表示',
  'view.export': 'GeoJSON 出力',
  'ex.val': '{x} 倍',

  'credits.title': '出典・加工',
  'credits.html':
    '<li>建物：国土交通省 Project PLATEAU 3D都市モデル（<a href="https://www.mlit.go.jp/plateau/" target="_blank" rel="noopener">PLATEAU</a>）を Pacific Spatial Solutions が変換した <a href="https://source.coop/pacificspatial/flateau-2-0" target="_blank" rel="noopener">Flateau V2</a>（<a href="https://creativecommons.org/licenses/by/4.0/deed.ja" target="_blank" rel="noopener">CC BY 4.0</a>）。Cloudflare R2 上の同一ファイルの複製から読込</li>' +
    '<li>型：<a href="https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html" target="_blank" rel="noopener">国土数値情報 行政区域データ（N03, 2026年）</a>（国土交通省, オープンデータ CC BY 4.0）。「国土数値情報（行政区域データ）」（国土交通省）を加工して作成</li>' +
    '<li>背景地図：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル 淡色地図</a></li>' +
    '<li>加工：建物フットプリントを行政界（移動・拡縮・回転後）で切断し、高さ属性で押し出して表示。行政界は同一コード内で結合し、座標を小数6桁に丸めています。</li>',

  'hud.dough': '素材',
  'hud.cutter': '型',
  'hud.result': '結果',
  'hud.none': '未選択',
  'hud.noresult': 'なし',
  'hud.preparing': '（準備中）',
  'hud.tpl': '{name}（{pref}・{code}）の行政界',
  'hud.res': '{n} 件（型：{tpl}、建物：{mat}）',
  'hud.stale': ' ※前回の配置の結果',

  'map.init': '地図：初期化中',
  'map.loaded': '地図：読込完了',
  'map.drawing': '地図：描画中',
  'map.done': '地図：描画完了',
  'map.shown': '地図：表示中',
  'map.tileErr': '（背景タイル取得エラー {n} 件）',
  'map.err': '地図のエラー：{msg}',

  'stage.engine': '解析エンジン',
  'stage.material': '素材',
  'stage.template': '型',
  'stage.count': '候補数の確認',
  'stage.fetch': '候補取得',
  'stage.intersect': '切断',
  'stage.export': '出力',
  'stage.done': '完了',
  'stage.unknown': '不明な段階',

  'st.elapsed': '経過 {t}',
  'st.boot': 'カタログと解析エンジンを準備中',
  'st.catalogFail': 'カタログの読込に失敗：{msg}',
  'st.engineReady': '解析エンジンの準備完了',
  'st.engineFail': '解析エンジンの起動に失敗：{msg}',
  'engine.info': '解析エンジン：DuckDB-Wasm {v} + spatial {s}（起動 {t}）',
  'st.matPreparing': '素材を準備中：{name}（取得元：{src}）',
  'src.r2': 'R2 の複製',
  'src.origin': '公開元 source.coop',
  'st.matReady': '素材の準備完了（{t}、取得 {b}・{n} 要求）。GEOM型：{g}{nb}',
  'st.noBBox': '／bbox列なし',
  'st.matFail': '素材の準備に失敗：{msg}',
  'st.clearedMat': '素材を切り替えたため、前の結果を消去しました',
  'st.clearedTpl': '型を切り替えたため、前の結果を消去しました',
  'st.notReady': '素材と型の準備が終わってから型抜きできます',
  'st.outside': '型が素材の提供範囲（点線の矩形）の外にあります。素材の範囲内へ移動してください。',
  'st.cutting': '型抜き中（{tpl} × {mat}）：{stage}',
  'st.start': '開始',
  'st.limit':
    '取得矩形内の元の建物が目安の {n} 件を超えました（{n} 件を超えた時点で読込を停止）。\n型の幅を小さくするか、「このまま実行」を押してください（建物を間引くことはしません）。',
  'st.limitStats': '判定までの所要時間：{t}<br>素材の取得（実測）：{b}／{n} 要求',
  'st.prevShown': '地図には前回の型抜き結果を表示しています。',
  'st.stale': '素材または型が変わったため、古い計算結果を破棄しました',
  'st.cutFail': '型抜きに失敗（{stage}）：{msg}',
  'st.noBldArea': '取得矩形に建物がありません（素材の範囲内ですが、この場所には建物データがありません）。',
  'st.noBldInside': '型の内側に建物がありません。型を動かしてください。',
  'st.done': '型抜き完了：{n} 件（総計 {t}{cache}）',
  'st.cacheReuse': '、候補はキャッシュを再利用',
  'st.partial': '型の一部が素材の提供範囲（点線）の外にあります。範囲外の部分には建物がありません。',
  'st.hmiss': '高さ不明 {n} 件は 0 m 扱い（灰色の薄板）で表示しています。',
  'st.workerFatal': '解析Worker の起動・実行に失敗しました：{msg}',
  'st.workerMsg': '解析Worker からのメッセージを復元できませんでした',

  'stats.cand': '元の建物（取得矩形・キャッシュ内）：{n} 件・{v} 頂点',
  'stats.touch': '型と交差：{n} 件 → 切断なし {w}／境界で切断 {c}／複数片 {m}／接するだけで除外 {d}／無効形状 {i}',
  'stats.time': '所要時間：{t}',
  'stats.transfer': '素材の取得（実測）：{b}／{n} 要求（部分取得 {r}・全体取得 {f}{fail}）',
  'stats.failN': '・失敗 {n}',

  'lg.nh': '高さ不明',
  'lg.whole': '切断なし',
  'lg.cut': '境界で切断',
  'lg.none0': 'なし（0 m 扱い）',
  'lg.cand': '元の建物（未切断）',
  'lg.preview': '型のプレビュー',
  'lg.plinth': '台座',
  'lg.note': '高さ倍率 {x} 倍・持ち上げ {l} m（表示のみ。出力の height_m は元の値）',

  'pp.building': '建物',
  'pp.height': '高さ',
  'pp.hUnknown': '不明（0 m 扱いで表示）',
  'pp.cut': '型の境界で切断',
  'pp.whole': '切断なし（型の内側）',
  'pp.from': '建物の出どころ',
  'pp.cutter': '型',

  's.sec': '{n} 秒',
  's.ms': '{n} ms',

  'w.starting': 'DuckDB-Wasm を起動中',
  'w.spatial': 'spatial 拡張を読込中（{v}）',
  'w.schema': 'スキーマを確認中（ヘッダのみ取得）',
  'w.tplProject': '型を解析平面へ変換中',
  'w.fetchWhole': '素材ファイル全体を取得中（{mb} MB）',
  'w.fetchWholeProg': '素材ファイル全体を取得中 {got} / {total} MB',
  'w.fetchCand': '取得矩形に重なる元の建物を取得・投影中',
  'w.cutting': '型を配置して切断中',
  'w.export': 'GeoJSON に変換中',
  'n.whole': 'ファイル全体 {mb} MB をメモリに保持',
  'n.overLimit': '{n} 件超で停止',
  'n.cand': '{n} 件 / {v} 頂点',
  'n.candGeo': '候補の表示用GeoJSON',
  'n.pieces': '型を {n} 片に分割',
  'n.out': '{n} 件',
  'e.raw': '{text}',
  'e.badNum': '数値が不正です: {name}',
  'e.badCrs': '解析CRSが許可範囲外です: {n}',
  'e.badRange': '範囲が不正です: {name}',
  'e.noDb': 'DuckDB が初期化されていません',
  'e.dbWorker': 'DuckDB Worker のエラー: {msg}',
  'e.timeoutStart': 'DuckDB-Wasm の起動が60秒以内に完了しませんでした',
  'e.timeoutSpatial': 'spatial 拡張の読込が90秒以内に完了しませんでした',
  'e.badUrl': '素材URLがカタログの形式と一致しません',
  'e.badMirror': 'R2 複製のURLがカタログの置き場所と一致しません',
  'e.mirrorName': 'R2 複製のファイル名が公開元と一致しません',
  'e.urlMismatch': '素材URLが公開元と一致しません',
  'e.crs': '未対応の素材CRSです: {crs}',
  'e.col': '素材に必要な列がありません: {c}',
  'e.code': '自治体コードが不正です',
  'e.gj': '型のGeoJSONを解析できません',
  'e.geomType': '型は Polygon/MultiPolygon である必要があります',
  'e.download': '素材ファイルを取得できません（HTTP {s}）',
  'e.matMismatch': '素材が選択状態と一致しません（再選択してください）',
  'e.tplMismatch': '型が選択状態と一致しません（再選択してください）',
  'e.width': '幅が不正です',
};

const DICTS: Record<Lang, Dict> = { en, ja };

/** 都道府県の英語名（JIS コード順） */
export const PREF_EN = [
  'Hokkaido', 'Aomori', 'Iwate', 'Miyagi', 'Akita', 'Yamagata', 'Fukushima', 'Ibaraki', 'Tochigi', 'Gunma',
  'Saitama', 'Chiba', 'Tokyo', 'Kanagawa', 'Niigata', 'Toyama', 'Ishikawa', 'Fukui', 'Yamanashi', 'Nagano',
  'Gifu', 'Shizuoka', 'Aichi', 'Mie', 'Shiga', 'Kyoto', 'Osaka', 'Hyogo', 'Nara', 'Wakayama',
  'Tottori', 'Shimane', 'Okayama', 'Hiroshima', 'Yamaguchi', 'Tokushima', 'Kagawa', 'Ehime', 'Kochi', 'Fukuoka',
  'Saga', 'Nagasaki', 'Kumamoto', 'Oita', 'Miyazaki', 'Kagoshima', 'Okinawa',
];
export const PREF_JA = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

function initialLang(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'en' || q === 'ja') return q;
  try {
    const s = localStorage.getItem('cutout.lang');
    if (s === 'en' || s === 'ja') return s;
  } catch {
    /* 保存領域が使えない環境では既定値 */
  }
  return 'en';
}

export let lang: Lang = initialLang();

export function setLang(l: Lang) {
  lang = l;
  try {
    localStorage.setItem('cutout.lang', l);
  } catch {
    /* 無視 */
  }
}

/** 文言を取り出し {name} を差し込む。未定義のキーはキーをそのまま返す（欠落に気づけるように） */
export function t(key: string, params?: Record<string, string | number>): string {
  const s = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** data-i18n 系の属性を持つ要素へ現在の言語の文言を入れる */
export function applyStatic(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n!)));
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml!)));
  root
    .querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')
    .forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder!)));
  root
    .querySelectorAll<HTMLElement>('[data-i18n-aria]')
    .forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria!)));
  document.documentElement.lang = lang;
  document.title = t('app.docTitle');
}

export const numberLocale = () => (lang === 'ja' ? 'ja-JP' : 'en-US');
