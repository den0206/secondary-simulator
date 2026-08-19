// Secondary Simulator webview.
// 入力は生の Pointer Events をそのまま拡張ホストへ流す（Phase 1）。
// タップ/スワイプ/ロングプレスの判定は端末側が行うため、ドラッグに画面が追従する。
const vscode = acquireVsCodeApi();
// 表示は <img> 1 つ。拡張ホストから届くフレーム（base64 JPEG）も、直結 MJPEG も
// 同じ要素に出す。以前は canvas + createImageBitmap で描いていたが、
// base64 を 1 バイトずつ詰め替えるループが要り、しかも同じ絵になるだけだった。
// data URL を渡せば Chromium が復号する。
const img = document.getElementById('simulator-img');
const overlay = document.getElementById('overlay');
const container = document.getElementById('simulator-container');
const touchOverlay = document.getElementById('touch-overlay');
const octx = touchOverlay.getContext('2d');
const deviceSelect = document.getElementById('device');
// フッターは「入力経路（#mode）」と「リソース（#stats）」の 2 つに分かれている。
// #stats だけ innerHTML で作り直すので、#mode の表示はそれに巻き込まれない。
const statsEl = document.getElementById('stats');
const modeEl = document.getElementById('mode');
const lamp = document.getElementById('lamp');

// ---- 文言 --------------------------------------------------------------------

// 拡張ホストが翻訳して HTML に埋めた辞書（index.html の #l10n-strings）。
// webview から vscode.l10n は触れないので、出来上がった文字列を受け取る。
const STRINGS = (() => {
  const el = document.getElementById('l10n-strings');
  try {
    return JSON.parse((el && el.textContent) || '{}');
  } catch {
    return {}; // 壊れていても英語のキー名で動き続ける
  }
})();

/** 翻訳を引く。未定義ならキーをそのまま返す（英語の原文がキーになっている）。 */
function t(key, ...args) {
  const text = STRINGS[key] !== undefined ? STRINGS[key] : key;
  if (args.length === 0) return text;
  return text.replace(/\{(\d)\}/g, (_, i) => (args[Number(i)] !== undefined ? args[Number(i)] : ''));
}

/** HTML に静的に書かれた文言を差し替える（起動時に 1 回だけ）。 */
function applyStaticStrings() {
  const all = document.querySelectorAll
    ? document.querySelectorAll('[data-i18n], [data-i18n-title]')
    : [];
  for (const el of all) {
    const key = el.getAttribute('data-i18n');
    if (key) {
      const icon = el.getAttribute('data-i18n-icon');
      el.textContent = icon ? `${icon} ${t(key)}` : t(key);
    }
    const titleKey = el.getAttribute('data-i18n-title');
    if (titleKey) el.title = t(titleKey);
  }
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 表示要素は常に <img>。座標の正規化とオーバーレイのサイズ合わせが参照する。
function displayEl() {
  return img;
}

// ---- 生ポインタ入力 ----------------------------------------------------------

const pointers = new Map(); // pointerId -> {x, y} 正規化座標
const order = []; // pointerId の順序
// pointerup / pointercancel を取りこぼすと pointerId が残る。タッチ環境では
// pointerId が毎回変わるので、上限が無いと押した回数だけ増え続ける。
const MAX_POINTERS = 10;
let mode = 0; // 0=なし, 1=1本指, 2=2本指
let lastSingle = {x: 0, y: 0};
let lastPair = [
  {x: 0, y: 0},
  {x: 0, y: 0},
];
let moveScheduled = false;
let trailPoints = [];

function norm(e) {
  const r = displayEl().getBoundingClientRect();
  return {
    x: clamp01((e.clientX - r.left) / r.width),
    y: clamp01((e.clientY - r.top) / r.height),
  };
}

function post(type, extra) {
  vscode.postMessage(Object.assign({type}, extra));
}

function activePair() {
  return [pointers.get(order[0]), pointers.get(order[1])];
}

function onPointerDown(e) {
  container.setPointerCapture?.(e.pointerId);
  const p = norm(e);
  if (!pointers.has(e.pointerId)) order.push(e.pointerId);
  pointers.set(e.pointerId, p);
  // 取りこぼした古い pointerId を落とす（現在の 1〜2 本より古いものだけが対象）
  while (order.length > MAX_POINTERS) {
    pointers.delete(order.shift());
  }

  const count = order.length;
  if (count === 1) {
    mode = 1;
    lastSingle = p;
    post('touchDown', {x: p.x, y: p.y});
    showRipple(e);
    trailPoints = [p];
  } else if (count === 2) {
    // 1本指セッションを閉じ、2本指を開始
    if (mode === 1) post('touchUp', {x: lastSingle.x, y: lastSingle.y});
    const [a, b] = activePair();
    lastPair = [a, b];
    mode = 2;
    post('touch2Down', {x: a.x, y: a.y, x2: b.x, y2: b.y});
    clearTrail();
  }
  e.preventDefault();
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, norm(e));
  if (!moveScheduled) {
    moveScheduled = true;
    requestAnimationFrame(flushMove);
  }
  e.preventDefault();
}

function flushMove() {
  moveScheduled = false;
  if (mode === 1) {
    const p = pointers.get(order[0]);
    if (p) {
      lastSingle = p;
      post('touchMove', {x: p.x, y: p.y});
      pushTrail(p);
    }
  } else if (mode === 2) {
    const [a, b] = activePair();
    if (a && b) {
      lastPair = [a, b];
      post('touch2Move', {x: a.x, y: a.y, x2: b.x, y2: b.y});
    }
  }
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  const p = norm(e);
  pointers.delete(e.pointerId);
  const idx = order.indexOf(e.pointerId);
  if (idx >= 0) order.splice(idx, 1);
  const count = order.length;

  if (mode === 2) {
    const [a, b] = lastPair;
    post('touch2Up', {x: a.x, y: a.y, x2: b.x, y2: b.y});
    mode = 0;
    if (count === 1) {
      // 残った指で1本指セッションを継続
      const r = pointers.get(order[0]);
      if (r) {
        mode = 1;
        lastSingle = r;
        post('touchDown', {x: r.x, y: r.y});
      }
    }
  } else if (mode === 1) {
    post('touchUp', {x: p.x, y: p.y});
    mode = 0;
    clearTrail();
  }
  e.preventDefault();
}

// コンテナに束ねて受ける（<img> はフレーム毎に src が変わるので直接は張らない）
container.addEventListener('pointerdown', onPointerDown);
container.addEventListener('pointermove', onPointerMove);
container.addEventListener('pointerup', onPointerUp);
container.addEventListener('pointercancel', onPointerUp);

// ---- 楽観的フィードバック（リップル・軌跡）----------------------------------

function showRipple(e) {
  if (!trailEnabled) return;
  const r = container.getBoundingClientRect();
  const dot = document.createElement('div');
  dot.className = 'touch-ripple';
  dot.style.left = e.clientX - r.left + 'px';
  dot.style.top = e.clientY - r.top + 'px';
  container.appendChild(dot);
  setTimeout(() => dot.remove(), 400);
}

function syncOverlaySize() {
  const r = displayEl().getBoundingClientRect();
  if (touchOverlay.width !== Math.round(r.width) || touchOverlay.height !== Math.round(r.height)) {
    touchOverlay.width = Math.round(r.width);
    touchOverlay.height = Math.round(r.height);
  }
}

function pushTrail(p) {
  if (!trailEnabled) return;
  trailPoints.push(p);
  if (trailPoints.length > 40) trailPoints.shift();
  drawTrail();
}

function drawTrail() {
  syncOverlaySize();
  const w = touchOverlay.width;
  const h = touchOverlay.height;
  octx.clearRect(0, 0, w, h);
  if (trailPoints.length < 2) return;
  octx.strokeStyle =
    getComputedStyle(document.documentElement).getPropertyValue('--vscode-focusBorder') ||
    '#007acc';
  octx.lineWidth = 3;
  octx.lineCap = 'round';
  octx.lineJoin = 'round';
  octx.beginPath();
  for (let i = 0; i < trailPoints.length; i++) {
    const x = trailPoints[i].x * w;
    const y = trailPoints[i].y * h;
    octx.globalAlpha = (i + 1) / trailPoints.length;
    if (i === 0) octx.moveTo(x, y);
    else octx.lineTo(x, y);
  }
  octx.stroke();
  octx.globalAlpha = 1;
}

function clearTrail() {
  trailPoints = [];
  octx.clearRect(0, 0, touchOverlay.width, touchOverlay.height);
}

// ---- キーボード --------------------------------------------------------------

// 修飾キー付き（Cmd+A / Ctrl+C など）は組み合わせとして送る。Shift 単独は文字自体が
// 大文字で届くので組み合わせにはせず、そのままテキストとして送る。
// 送り先は HID 経路のみ（WDA の device.io.text は修飾キーを扱えない）。
function modifiersOf(e) {
  if (!(e.metaKey || e.ctrlKey || e.altKey)) return undefined;
  const mods = [];
  if (e.metaKey) mods.push('command');
  if (e.ctrlKey) mods.push('control');
  if (e.altKey) mods.push('option');
  if (e.shiftKey) mods.push('shift');
  return mods;
}

// 特殊キー（1 文字にならないもの）→ 拡張ホストが解釈する名前。
// 矢印は HID usage が元からあるのに、ここに無かったため送られていなかった
// （`e.key.length === 1` に一致しない）。
const SPECIAL_KEYS = {
  Backspace: 'delete',
  Enter: 'return',
  Escape: 'escape',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

// テキストを受ける要素にフォーカスがあるあいだはデバイスへ送らない。
// デバイス選択の <select> を開いて機種名を打つ（ブラウザ標準の type-ahead）と、
// その文字までデバイスに入っていた。
const TEXT_UI = ['SELECT', 'INPUT', 'TEXTAREA', 'OPTION'];

/**
 * このキーをデバイスへ送らずに UI へ譲るか。
 *
 * **ボタンは全部は譲らない。** クリックした操作ボタン（Home / Rec など）は
 * フォーカスを保つので、全部譲ると「Home を押したあと文字が打てない」になる。
 * ボタンを起動するキー（Enter / Space）だけ譲れば足りる。
 */
function isEditingUi(target, key) {
  if (!target || typeof target.tagName !== 'string') return false;
  if (TEXT_UI.includes(target.tagName)) return true;
  return target.tagName === 'BUTTON' && (key === 'Enter' || key === ' ');
}

document.addEventListener('keydown', (e) => {
  // デバイス未選択（オーバーレイ表示中）ならキー入力を送らない
  if (!overlay.classList.contains('hidden')) return;
  if (isEditingUi(e.target, e.key)) return;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) return;

  // Cmd/Ctrl+V は paste イベントに任せる（1 文字ずつ送らない）
  if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) return;

  const modifiers = modifiersOf(e);

  const special = SPECIAL_KEYS[e.key];
  if (special) {
    post('keypress', {key: special, special: true, modifiers});
    e.preventDefault();
    return;
  }
  if (e.key.length === 1) {
    post('keypress', {key: e.key, modifiers});
    e.preventDefault();
  }
});

// 貼り付け。1 文字ずつのキー送出では URL の入力が現実的でないため、
// まとめてホストへ渡す（ホスト側が経路に応じて HID / WDA へ流す）。
// 長さの上限はホストも持つが、巨大なテキストを postMessage に載せない。
const MAX_PASTE_CHARS = 4096;
document.addEventListener('paste', (e) => {
  if (!overlay.classList.contains('hidden')) return;
  if (isEditingUi(e.target, 'v')) return;
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (!text) return;
  post('paste', {text: text.slice(0, MAX_PASTE_CHARS)});
  e.preventDefault();
});

// ---- デバイス選択・ボタン ----------------------------------------------------

const btnBack = document.getElementById('btn-back');
const btnRecord = document.getElementById('btn-record');
// deviceId -> {platform, booted}。<option> を作り直しても引けるように持つ。
const deviceById = new Map();

// iOS に Back は存在しないので押せないようにする（未選択時も同様）
function syncBackButton() {
  const info = deviceById.get(deviceSelect.value);
  btnBack.disabled = !info || info.platform !== 'android';
}

deviceSelect.addEventListener('change', () => {
  syncBackButton();
  const id = deviceSelect.value;
  const info = deviceById.get(id);
  // 停止中を選んだら起動を尋ねる。以前は「起動していません」で終わっていて、
  // コマンドパレット経由（起動できる）と結果が違っていた。
  if (id && info && !info.booted) {
    vscode.postMessage({type: 'bootDevice', deviceId: id});
    return;
  }
  vscode.postMessage({type: 'deviceChange', deviceId: id});
});
document.getElementById('btn-home').addEventListener('click', () => post('home'));
btnBack.addEventListener('click', () => post('back'));
document
  .getElementById('btn-disconnect')
  .addEventListener('click', () => post('disconnect'));
document
  .getElementById('btn-refresh')
  .addEventListener('click', () => post('refresh'));
document
  .getElementById('btn-shot')
  .addEventListener('click', () => post('screenshot'));
btnRecord.addEventListener('click', () => post('record'));

// エラー表示からの復帰。オーバーレイの中にだけ出る。
document.getElementById('btn-retry').addEventListener('click', () => post('retry'));
document.getElementById('btn-logs').addEventListener('click', () => post('showLogs'));

// 録画中かどうか。ホストが持つ状態を写すだけで、ここでは決めない。
let recording = false;
function syncRecordButton() {
  btnRecord.classList.toggle('recording', recording);
  btnRecord.textContent = recording ? t('recordStop') : t('recordStart');
}
syncRecordButton();

// タップのリップルとドラッグ軌跡の表示切替。状態は webview の state に残す。
const btnTrail = document.getElementById('btn-trail');
let trailEnabled = vscode.getState()?.trail ?? true;

function syncTrailButton() {
  btnTrail.classList.toggle('on', trailEnabled);
  btnTrail.textContent = trailEnabled ? t('trailOn') : t('trailOff');
  if (!trailEnabled) clearTrail();
}

btnTrail.addEventListener('click', () => {
  trailEnabled = !trailEnabled;
  vscode.setState(Object.assign({}, vscode.getState(), {trail: trailEnabled}));
  syncTrailButton();
});
syncTrailButton();

// 自動接続の切替。状態は設定（secondarySimulator.autoConnect）が持つので、
// 押した直後は仮に反映し、拡張ホストからの autoConnect メッセージで確定させる。
const btnAuto = document.getElementById('btn-auto');
let autoConnectEnabled = true;

function syncAutoButton() {
  btnAuto.classList.toggle('on', autoConnectEnabled);
  btnAuto.textContent = autoConnectEnabled ? t('autoOn') : t('autoOff');
}

btnAuto.addEventListener('click', () => {
  autoConnectEnabled = !autoConnectEnabled;
  syncAutoButton();
  vscode.postMessage({type: 'setAutoConnect', enabled: autoConnectEnabled});
});
syncAutoButton();

// ---- レンダリング -----------------------------------------------------------

// 直結 MJPEG（streamUrl）を表示しているか。フレーム個別配信と onerror の扱いが違う。
let streamMode = false;
// 実際に描けたフレーム数。resources の更新時に読んで 0 に戻す（貯めない）。
// 拡張ホストが数える「受信 fps」との差が、そのまま落としたフレームになる。
let paintedFrames = 0;
let paintedSince = Date.now();

/** 前回の集計からの描画 fps を返し、カウンタを 0 に戻す。 */
function takePaintedFps() {
  const now = Date.now();
  const seconds = (now - paintedSince) / 1000;
  const count = paintedFrames;
  paintedFrames = 0;
  paintedSince = now;
  if (!(seconds > 0)) return 0;
  // 集計期間が極端に短いと 1 枚で 1000fps になる。表示の上限は取り込みと同じ 60。
  return Math.min(60, Math.round((count / seconds) * 10) / 10);
}

// 拡張ホストは base64 の JPEG を送る（postMessage のシリアライズで形がぶれないため）。
// data URL にして <img> へ渡すと、復号も落としたフレームの間引きも Chromium がやる。
function showFrame(base64) {
  if (typeof base64 !== 'string' || !base64) return;
  streamMode = false;
  img.src = 'data:image/jpeg;base64,' + base64;
}

// 表示を止める。src="" にすると Chromium はページ自身の URL を読みに行くので、
// 属性ごと外す（直結ストリームではこれが GET の切断になる）。
function clearImage() {
  streamMode = false;
  img.removeAttribute('src');
}

img.addEventListener('load', () => {
  paintedFrames++;
  if (img.naturalWidth && img.naturalHeight) {
    lastReportedWidth = 0;
    reportViewport();
  }
  setOverlayVisible(false);
});

// 表示中の実ピクセル幅をホストへ伝える。取り込みの幅がこれに追従する
// （狭いサイドバーへ 640px を送り続けない）。
let lastReportedWidth = 0;
function reportViewport() {
  // <img> ではなくコンテナを測る（img は最初のフレームまで display:none で幅が 0）
  const width = Math.round(
    container.getBoundingClientRect().width * (window.devicePixelRatio || 1)
  );
  // 数 px の揺れで送らない（ホスト側も同じ幅で弾くが、無駄な postMessage を作らない）
  if (!width || Math.abs(width - lastReportedWidth) < 16) return;
  lastReportedWidth = width;
  post('viewport', {width});
}

// ResizeObserver が無い環境（古い Electron）では resize イベントで代用する
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(reportViewport).observe(container);
} else {
  window.addEventListener('resize', reportViewport);
}

img.addEventListener('error', () => {
  // 直結ストリームは接続そのものが切れた合図。個別フレームは 1 枚壊れただけなので
  // 次のフレームで直る（毎秒 30 回届く経路で警告を出さない）。
  if (streamMode) setOverlayVisible(true, t('streamFailed'));
});

let overlayVisible = null; // 直近に適用した状態。frame 毎の DOM 書き換えを避ける
let overlayText = null;
let overlayActionsShown = null;
const overlayActions = document.getElementById('overlay-actions');

/**
 * @param actions エラーのときだけ true。［再試行］［ログを見る］を出す。
 *   待機中（Searching / Connecting）に出すと、押しても同じ待ちに戻るだけなので出さない。
 */
function setOverlayVisible(
  visible,
  text = t('selectToStart'),
  busy = false,
  actions = false
) {
  if (!overlay) return;
  // 'frame' は毎秒 30 回届く（load も同じ回数）。状態が同じなら DOM を触らない。
  if (
    overlayVisible === visible &&
    overlayActionsShown === actions &&
    (!visible || overlayText === text)
  ) {
    return;
  }
  overlayVisible = visible;
  overlayText = text;
  overlayActionsShown = actions;
  overlayActions.classList.toggle('shown', visible && actions);
  // 画面が出ている＝接続中。オーバーレイの表示状態がそのまま接続状態になる。
  lamp.classList.toggle('on', !visible);
  lamp.title = visible ? t('lampDisconnected') : t('lampConnected');
  overlay.classList.toggle('hidden', !visible);
  // 待機中（Searching / Connecting）はスピナーを出す。呼び出し側が明示する
  // ——「…」を含むかで見ていたが、言語によって記号が変わるので当てにできない。
  overlay.classList.toggle('busy', visible && busy);
  overlay.querySelector('span').textContent = text;
  img.style.display = visible ? 'none' : 'block';
}

function cleanup() {
  overlayVisible = null;
  overlayText = null;
  overlayActionsShown = null;
  clearTrail();
  pointers.clear();
  order.length = 0;
  mode = 0;
  // 表示を閉じる（直結ストリームなら接続も切れる）
  clearImage();
}

// ---- 拡張ホストからのメッセージ ----------------------------------------------

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'devices': {
      const selected = deviceSelect.value;
      deviceSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = t('selectDevice');
      deviceSelect.appendChild(placeholder);
      deviceById.clear();

      // プラットフォームごとに束ねる。混在した一覧から目的の端末を探しにくかった。
      // 台数 0 の <optgroup> は作らない。
      const groups = new Map(); // platform -> <optgroup>
      const groupFor = (platform) => {
        let g = groups.get(platform);
        if (g) return g;
        g = document.createElement('optgroup');
        g.label = platform === 'ios' ? t('groupIos') : t('groupAndroid');
        groups.set(platform, g);
        deviceSelect.appendChild(g);
        return g;
      };

      message.devices.forEach((device) => {
        const booted = device.state === 'Booted';
        deviceById.set(device.id, {platform: device.platform, booted});
        const option = document.createElement('option');
        option.value = device.id;
        // 起動中は状態を書かない（大半が起動中で、毎行に付くと名前が読みにくい）
        option.textContent = booted
          ? device.name
          : `${device.name} — ${t('stopped')}`;
        groupFor(device.platform).appendChild(option);
      });

      // 再取得しても選択中のデバイスは維持する。消えていたらホストのキャプチャも止める。
      const next = deviceById.has(selected) ? selected : '';
      deviceSelect.value = next;
      syncBackButton();
      if (selected && next === '') {
        vscode.postMessage({type: 'deviceChange', deviceId: ''});
        cleanup();
        setOverlayVisible(true, t('disconnected'));
      }
      break;
    }

    // 見た目の好み（設定が持つもの）。ホストから来た値をそのまま反映する。
    case 'settings':
      document.body.classList.toggle('no-frame', message.showDeviceFrame === false);
      document.body.classList.toggle('hide-stats', message.showResourceStats === false);
      break;

    case 'recording':
      recording = message.active === true;
      syncRecordButton();
      break;

    // 未接続で起動中デバイスを探している間。やめたときは自分が出した文言だけ戻す
    // （Disconnect やエラーの表示を上書きしないため）。
    case 'searching':
      if (message.active) {
        setOverlayVisible(true, t('searching'), true);
      } else if (overlay.querySelector('span').textContent === t('searching')) {
        setOverlayVisible(true, t('selectToStart'));
      }
      break;

    // 接続開始。最初のフレーム（frame / img.onload）が来るまで出したままにする。
    case 'connecting':
      setOverlayVisible(true, t('connectingTo', message.name), true);
      break;

    // 設定側の値。設定画面から変えたときもここで揃う。
    case 'autoConnect':
      autoConnectEnabled = message.enabled;
      syncAutoButton();
      break;

    // 拡張ホストが自動接続したデバイスを <select> に反映する（change は発火させない）
    case 'selectedDevice':
      deviceSelect.value = message.deviceId;
      syncBackButton();
      break;

    case 'streamUrl': {
      // Phase 2: <img> に MJPEG を直結。Chromium が multipart をネイティブ復号する。
      // 初回は WDA 起動待ちで最初のフレームまで数秒かかることがあるため、
      // 実際に表示できるまでオーバーレイで待機中を示す（load で消える）。
      streamMode = true;
      setOverlayVisible(true, t('connecting'), true);
      img.src = message.url;
      break;
    }

    case 'frame':
      // load ハンドラが paintedFrames を数え、オーバーレイを消す
      showFrame(message.data);
      break;

    // 入力経路（HID 直接注入 / WDA 経由）。降格すると無音で遅くなるので見えるようにする。
    // 文字列は拡張ホスト由来なので textContent で入れる（innerHTML にしない）。
    case 'mode':
      modeEl.textContent = message.text || '';
      modeEl.style.display = message.text ? '' : 'none';
      break;

    case 'resources': {
      // 値は拡張ホストが作った数値のみ。<b> ラベル付きのチップに並べる。
      const chip = (label, value) => `<span class="chip"><b>${label}</b> ${value}</span>`;
      // 受信（拡張ホストが数えた fps）と描画（この webview が描けた数）を並べる。
      // 差がそのまま落としたフレームで、同期の質はここに出る。
      const painted = takePaintedFps();
      // 直結中はフレームが拡張ホストを通らないので、受信 fps と帯域は測れない。
      // 描画側の数字だけを出す（測れないものを 0 と出さない）。
      // 直結では multipart の 1 コマごとに load が来るとは限らない。
      // 数えられていないのに 0fps と出すと壊れて見えるので、そのときは伏せる。
      const rate = message.direct
        ? chip(t('video'), painted > 0 ? `${painted}fps ${t('direct')}` : t('direct'))
        : message.fps === undefined
          ? ''
          : chip(t('video'), `${message.fps}/${painted}fps ${message.kbps}KB/s`);
      statsEl.innerHTML =
        rate +
        chip(t('host'), message.rssMb + 'MB') +
        chip(t('heap'), message.heapUsedMb + 'MB') +
        chip(t('children'), message.childrenMb + 'MB') +
        // 測っているのは拡張ディレクトリ（VSIX 同梱物）だけ。mobilecli が入れる
        // WebDriverAgent や npx の npm キャッシュは含まれないので「ストレージ」とは呼ばない。
        chip(t('extension'), message.storageMb + 'MB');
      break;
    }

    case 'error':
      cleanup();
      // 文言だけ出して終わりにしない。ここから再試行とログへ行ける。
      setOverlayVisible(true, message.text, false, true);
      break;

    case 'disconnected':
      cleanup();
      // 同じデバイスを選び直しても change が飛ぶように選択を空へ戻す（復帰導線）
      deviceSelect.value = '';
      syncBackButton();
      setOverlayVisible(true, t('disconnected'));
      break;

    case 'pauseStream':
      // 非表示・切替時。overlay は触らず表示だけ閉じる（再開時に streamUrl / frame が来る）
      clearImage();
      break;
  }
});

// <img> は width:100% なのでリサイズ時に再描画は要らない（canvas 経路の名残を削除）。
window.addEventListener('beforeunload', cleanup);

applyStaticStrings();
vscode.postMessage({type: 'init'});
