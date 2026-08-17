// main.js のポインタ状態機械を DOM スタブ上で実行し、送信されるメッセージ列を検証する。
// 実ブラウザは使わず、必要最小限の DOM API だけを模擬する。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'media', 'webview', 'main.js');

const sent = [];
let webviewState; // vscode.getState/setState の保存先
let resizeCallback = null; // ResizeObserver に渡された callback
let resizeObserved = null; // observe された要素
const listeners = {}; // "elementId:event" -> handler
// 要素に addEventListener で張られたハンドラ（同じイベントに複数張れる）
const elListeners = {}; // "elementId:event" -> [handler]

function makeEl(id, opts = {}) {
  const el = {
    id,
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(ev, fn) {
      listeners[`${id}:${ev}`] = fn;
      (elListeners[`${id}:${ev}`] ||= []).push(fn);
    },
    removeEventListener() {},
    getBoundingClientRect: () =>
      opts.rect || {left: 0, top: 0, width: 300, height: 600},
    setPointerCapture() {},
    releasePointerCapture() {},
    appendChild() {},
    removeChild() {},
    // removeAttribute('src') は .src も空にする（実 DOM と同じ）
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    remove() {},
    querySelector: () => ({textContent: ''}),
    getContext: () => ({
      clearRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {},
      stroke() {}, save() {}, restore() {},
      set strokeStyle(v) {}, set lineWidth(v) {}, set lineCap(v) {},
      set lineJoin(v) {}, set globalAlpha(v) {},
    }),
    width: 300,
    height: 600,
    innerHTML: '',
    textContent: '',
    src: '',
  };
  return el;
}

const els = {
  'simulator-img': makeEl('simulator-img'),
  overlay: makeEl('overlay'),
  'simulator-container': makeEl('simulator-container'),
  'touch-overlay': makeEl('touch-overlay'),
  device: makeEl('device'),
  'btn-home': makeEl('btn-home'),
  'btn-back': makeEl('btn-back'),
  'btn-disconnect': makeEl('btn-disconnect'),
  'btn-trail': makeEl('btn-trail'),
  lamp: makeEl('lamp'),
  stats: makeEl('stats'),
  mode: makeEl('mode'),
};

const sandbox = {
  console,
  acquireVsCodeApi: () => ({
    postMessage: (m) => sent.push(m),
    getState: () => webviewState,
    setState: (s) => (webviewState = s),
  }),
  document: {
    getElementById: (id) => els[id] || makeEl(id),
    createElement: (t) => makeEl('created-' + t),
    addEventListener(ev, fn) { listeners[`document:${ev}`] = fn; },
    documentElement: {},
  },
  window: {
    addEventListener(ev, fn) { listeners[`window:${ev}`] = fn; },
    devicePixelRatio: 2,
  },
  getComputedStyle: () => ({getPropertyValue: () => '#007acc'}),
  // 表示幅の通知に使う。observe された対象と callback を覚えておく
  ResizeObserver: class {
    constructor(cb) { resizeCallback = cb; }
    observe(el) { resizeObserved = el; }
    disconnect() {}
  },
  requestAnimationFrame: (fn) => { fn(); return 1; },
  cancelAnimationFrame: () => {},
  setTimeout, clearTimeout, performance, Date,
};

sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, {filename: 'main.js'});

// ---- テスト ----
function fire(target, ev, obj) {
  const fn = listeners[`${target}:${ev}`];
  if (!fn) throw new Error(`no listener ${target}:${ev}`);
  fn(Object.assign({preventDefault() {}, pointerId: 1}, obj));
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failures++; }
}

console.log('1) 起動時に init を送る');
check('init 送信', sent.some((m) => m.type === 'init'));

console.log('\n2) 1本指ドラッグ: down → move → up');
sent.length = 0;
// rect: left0 top0 w300 h600 → (150,300) は正規化 (0.5, 0.5)
fire('simulator-container', 'pointerdown', {clientX: 150, clientY: 300});
fire('simulator-container', 'pointermove', {clientX: 150, clientY: 150});
fire('simulator-container', 'pointerup', {clientX: 150, clientY: 60});
const types = sent.map((m) => m.type);
check('touchDown→touchMove→touchUp の順',
  JSON.stringify(types) === JSON.stringify(['touchDown', 'touchMove', 'touchUp']),
  JSON.stringify(types));
check('down の正規化座標 (0.5,0.5)', sent[0].x === 0.5 && sent[0].y === 0.5,
  `${sent[0].x},${sent[0].y}`);
check('move の正規化座標 (0.5,0.25)', sent[1].x === 0.5 && sent[1].y === 0.25,
  `${sent[1].x},${sent[1].y}`);
check('up の正規化座標 (0.5,0.1)', sent[2].x === 0.5 && Math.abs(sent[2].y - 0.1) < 1e-9,
  `${sent[2].x},${sent[2].y}`);

console.log('\n3) 座標は [0,1] にクランプされる');
sent.length = 0;
fire('simulator-container', 'pointerdown', {clientX: -50, clientY: 900});
check('負値と超過をクランプ', sent[0].x === 0 && sent[0].y === 1,
  `${sent[0].x},${sent[0].y}`);
fire('simulator-container', 'pointerup', {clientX: 0, clientY: 0});

console.log('\n4) 2本指: 2本目 down で 1本目を閉じて touch2Down');
sent.length = 0;
fire('simulator-container', 'pointerdown', {pointerId: 1, clientX: 90, clientY: 300});
fire('simulator-container', 'pointerdown', {pointerId: 2, clientX: 210, clientY: 300});
const t2 = sent.map((m) => m.type);
check('touchDown→touchUp→touch2Down',
  JSON.stringify(t2) === JSON.stringify(['touchDown', 'touchUp', 'touch2Down']),
  JSON.stringify(t2));
const d2 = sent[2];
check('touch2Down に2点が入る', d2.x === 0.3 && d2.x2 === 0.7, `${d2.x},${d2.x2}`);

console.log('\n5) 2本指 move → 片方 up で1本指へ復帰');
sent.length = 0;
fire('simulator-container', 'pointermove', {pointerId: 2, clientX: 240, clientY: 300});
fire('simulator-container', 'pointerup', {pointerId: 2, clientX: 240, clientY: 300});
const t3 = sent.map((m) => m.type);
check('touch2Move→touch2Up→touchDown',
  JSON.stringify(t3) === JSON.stringify(['touch2Move', 'touch2Up', 'touchDown']),
  JSON.stringify(t3));
fire('simulator-container', 'pointerup', {pointerId: 1, clientX: 90, clientY: 300});

// <img> の load / error は addEventListener で張られる
function fireImg(ev) {
  for (const fn of elListeners[`simulator-img:${ev}`] || []) fn({});
}

console.log('\n6) streamUrl で img 直結に切り替わる');
sent.length = 0;
listeners['window:message']({data: {type: 'streamUrl', url: 'http://localhost:12200/stream?device=X'}});
check('img.src が設定される', els['simulator-img'].src.includes('/stream?device=X'),
  els['simulator-img'].src);
check('最初のフレームまで待機表示', !els.overlay.classList.contains('hidden'));
// 最初のフレーム到達
fireImg('load');
check('load で img が表示される', els['simulator-img'].style.display === 'block');
check('load でオーバーレイが消える', els.overlay.classList.contains('hidden'));
// 直結中の error は接続断。フレーム個別配信の error は無視される（14b）
fireImg('error');
check('直結の error は接続断として出す',
  !els.overlay.classList.contains('hidden') &&
    els.overlay.classList.contains('busy') === false);

console.log('\n7) 直結中も pointer が img の矩形で正規化される');
sent.length = 0;
fire('simulator-container', 'pointerdown', {clientX: 150, clientY: 300});
check('img 経路でも (0.5,0.5)', sent[0].x === 0.5 && sent[0].y === 0.5,
  `${sent[0].x},${sent[0].y}`);
fire('simulator-container', 'pointerup', {clientX: 150, clientY: 300});

console.log('\n8) disconnected でストリームを閉じる');
listeners['window:message']({data: {type: 'disconnected'}});
check('img.src がクリアされる', els['simulator-img'].src === '', els['simulator-img'].src);

console.log('\n8b) pauseStream は src だけ閉じる');
listeners['window:message']({data: {type: 'streamUrl', url: 'http://localhost:12200/stream?device=X'}});
fireImg('load');
listeners['window:message']({data: {type: 'pauseStream'}});
check('pauseStream で img.src がクリアされる', els['simulator-img'].src === '', els['simulator-img'].src);

console.log('\n9) デバイス未選択ならキー入力を送らない');
sent.length = 0;
els.overlay.classList.remove('hidden'); // オーバーレイ表示中
listeners['document:keydown']({key: 'a', preventDefault() {}});
check('キー入力が抑止される', sent.length === 0, JSON.stringify(sent));
els.overlay.classList.add('hidden'); // 非表示（デバイス選択中）
listeners['document:keydown']({key: 'a', preventDefault() {}});
check('選択中はキー入力を送る', sent.some((m) => m.type === 'keypress' && m.key === 'a'));

console.log('\n9b) 修飾キー付きは組み合わせとして送る');
sent.length = 0;
listeners['document:keydown']({key: 'a', metaKey: true, preventDefault() {}});
check(
  'Cmd+A は modifiers 付きで送る',
  sent.some(
    (m) =>
      m.type === 'keypress' &&
      m.key === 'a' &&
      JSON.stringify(m.modifiers) === JSON.stringify(['command'])
  ),
  JSON.stringify(sent)
);
sent.length = 0;
listeners['document:keydown']({
  key: 'C',
  metaKey: true,
  shiftKey: true,
  preventDefault() {},
});
check(
  'Cmd+Shift+C は両方入る',
  sent.some(
    (m) => JSON.stringify(m.modifiers) === JSON.stringify(['command', 'shift'])
  ),
  JSON.stringify(sent)
);
sent.length = 0;
listeners['document:keydown']({key: 'A', shiftKey: true, preventDefault() {}});
check(
  'Shift 単独は組み合わせにしない（文字が大文字で届く）',
  sent.some((m) => m.key === 'A' && m.modifiers === undefined),
  JSON.stringify(sent)
);
sent.length = 0;
listeners['document:keydown']({key: 'Backspace', altKey: true, preventDefault() {}});
check(
  '特殊キーにも modifiers が付く',
  sent.some(
    (m) =>
      m.key === 'delete' &&
      m.special === true &&
      JSON.stringify(m.modifiers) === JSON.stringify(['option'])
  ),
  JSON.stringify(sent)
);

console.log('\n9c) 入力経路のチップ');
listeners['window:message']({data: {type: 'mode', text: '互換モード (WDA)'}});
check('mode の文言を出す', els.mode.textContent === '互換モード (WDA)', els.mode.textContent);
check('表示される', els.mode.style.display === '', els.mode.style.display);
listeners['window:message']({data: {type: 'mode', text: null}});
check('未接続では隠す', els.mode.style.display === 'none', els.mode.style.display);
listeners['window:message']({
  data: {type: 'resources', rssMb: 1, heapUsedMb: 2, childrenMb: 3, storageMb: 4},
});
check('リソース更新は #stats だけを書き換える', els.mode.style.display === 'none');
check('リソースが #stats に入る', els.stats.innerHTML.includes('4MB'), els.stats.innerHTML);

console.log('\n10) Back ボタンは Android のときだけ押せる');
listeners['window:message']({
  data: {
    type: 'devices',
    devices: [
      {id: 'ios-1', name: 'iPhone', state: 'Booted', platform: 'ios'},
      {id: 'and-1', name: 'Pixel', state: 'Booted', platform: 'android'},
    ],
  },
});
check('未選択では無効', els['btn-back'].disabled === true);
els.device.value = 'ios-1';
listeners['device:change']();
check('iOS では無効', els['btn-back'].disabled === true);
els.device.value = 'and-1';
listeners['device:change']();
check('Android では有効', els['btn-back'].disabled === false);

console.log('\n10b) 一覧から消えたデバイスはホスト側も切断する');
els.device.value = 'ios-1';
sent.length = 0;
listeners['window:message']({
  data: {
    type: 'devices',
    devices: [
      {id: 'ios-1', name: 'iPhone', state: 'Booted', platform: 'ios'},
      {id: 'and-1', name: 'Pixel', state: 'Booted', platform: 'android'},
    ],
  },
});
check('残っていれば選択を維持', els.device.value === 'ios-1');
check('維持時は deviceChange を送らない', !sent.some((m) => m.type === 'deviceChange'));
sent.length = 0;
listeners['window:message']({
  data: {
    type: 'devices',
    devices: [{id: 'and-1', name: 'Pixel', state: 'Booted', platform: 'android'}],
  },
});
check('消えたら選択が空', els.device.value === '');
check(
  'deviceChange 空を送る',
  sent.some((m) => m.type === 'deviceChange' && m.deviceId === '')
);
check('ランプが赤', !els.lamp.classList.contains('on'));

console.log('\n11) disconnected 後は選択を戻して復帰できる');
listeners['window:message']({data: {type: 'disconnected'}});
check('選択が空に戻る', els.device.value === '', els.device.value);
check('Back も無効に戻る', els['btn-back'].disabled === true);
sent.length = 0;
listeners['btn-refresh:click']();
check('Refresh が refresh を送る', sent.some((m) => m.type === 'refresh'));

console.log('\n12) 接続ランプ');
listeners['window:message']({data: {type: 'frame', data: 'AQ=='}});
fireImg('load'); // 実際に描けたときに接続とみなす
check('接続中は緑（on）', els.lamp.classList.contains('on'));
listeners['window:message']({data: {type: 'disconnected'}});
check('切断で赤（on が外れる）', !els.lamp.classList.contains('on'));

console.log('\n12.5) 待機中スピナー');
listeners['window:message']({data: {type: 'connecting', name: 'iPhone 15'}});
check('「…」を含む文言は busy', els.overlay.classList.contains('busy'));
listeners['window:message']({data: {type: 'error', text: '接続に失敗しました'}});
check('通常の文言は busy でない', !els.overlay.classList.contains('busy'));

console.log('\n13) Trail トグル');
check('初期は ON', els['btn-trail'].classList.contains('on'));
// ripple は container.appendChild で追加される。呼ばれたかを数える。
let appended = 0;
els['simulator-container'].appendChild = () => appended++;
fire('simulator-container', 'pointerdown', {clientX: 150, clientY: 300});
fire('simulator-container', 'pointermove', {clientX: 150, clientY: 200});
fire('simulator-container', 'pointerup', {clientX: 150, clientY: 200});
check('ON ならリップルを描く', appended === 1, String(appended));

listeners['btn-trail:click']();
check('トグルで OFF', !els['btn-trail'].classList.contains('on'));
check('state に残る', webviewState && webviewState.trail === false,
  JSON.stringify(webviewState));
appended = 0;
sent.length = 0;
fire('simulator-container', 'pointerdown', {clientX: 150, clientY: 300});
fire('simulator-container', 'pointermove', {clientX: 150, clientY: 200});
fire('simulator-container', 'pointerup', {clientX: 150, clientY: 200});
check('OFF ならリップルを描かない', appended === 0, String(appended));
check('OFF でも入力は送る',
  sent.filter((m) => m.type.startsWith('touch')).length === 3,
  JSON.stringify(sent.map((m) => m.type)));

console.log('\n14) フレームの受け取り（base64 → data URL）');

// 拡張ホストは Buffer.toString('base64') で送る。UTF-8 として不正なバイトを含む
// JPEG でも、data URL に載る base64 が 1 文字も変わってはいけない。
const original = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x7f, 0x80, 0xc3, 0xff, 0xd9]);
const b64 = original.toString('base64');
listeners['window:message']({data: {type: 'frame', encoding: 'base64', data: b64}});
check('data URL として <img> に渡す',
  els['simulator-img'].src === 'data:image/jpeg;base64,' + b64,
  els['simulator-img'].src);
check('復号すると元のバイト列に戻る',
  Buffer.from(els['simulator-img'].src.split(',')[1], 'base64').equals(original));

// 文字列以外（旧形式の残骸・壊れた通知）で src を壊さない
const before = els['simulator-img'].src;
listeners['window:message']({data: {type: 'frame', data: {type: 'Buffer', data: [1, 2, 3]}}});
listeners['window:message']({data: {type: 'frame', data: null}});
check('base64 文字列以外は無視する', els['simulator-img'].src === before,
  els['simulator-img'].src);

console.log('\n14b) 個別フレームの error は無視する');
// 直結ストリームと違い、1 枚壊れただけなので次のフレームで直る。
// ここで警告を出すと毎秒 30 回の経路でオーバーレイが点滅する。
listeners['window:message']({data: {type: 'frame', encoding: 'base64', data: b64}});
fireImg('load');
fireImg('error');
check('オーバーレイを出さない', els.overlay.classList.contains('hidden'));

console.log('\n15) 映像レートを受信/描画で並べる');
listeners['window:message']({data: {type: 'frame', encoding: 'base64', data: b64}});
fireImg('load');
listeners['window:message']({
  data: {
    type: 'resources',
    rssMb: 1, heapUsedMb: 2, childrenMb: 3, storageMb: 4,
    fps: 28.5, kbps: 512,
  },
});
check('受信 fps と帯域が出る', els.stats.innerHTML.includes('28.5/'), els.stats.innerHTML);
check('KB/s が出る', els.stats.innerHTML.includes('512KB/s'), els.stats.innerHTML);
check('メモリの単位が残る', els.stats.innerHTML.includes('4MB'), els.stats.innerHTML);
// カウンタは読んだら 0 に戻る（貯めない）
listeners['window:message']({
  data: {
    type: 'resources',
    rssMb: 1, heapUsedMb: 2, childrenMb: 3, storageMb: 4,
    fps: 0, kbps: 0,
  },
});
check('描画カウンタは持ち越さない', els.stats.innerHTML.includes('0/0fps'),
  els.stats.innerHTML);
// 直結中は受信側を測れないので、描画 fps だけを出す
listeners['window:message']({data: {type: 'frame', encoding: 'base64', data: b64}});
fireImg('load');
listeners['window:message']({
  data: {type: 'resources', rssMb: 1, heapUsedMb: 2, childrenMb: 3, storageMb: 4, direct: true},
});
check('直結では「直結」と描画 fps だけ', els.stats.innerHTML.includes('fps 直結'),
  els.stats.innerHTML);
check('直結では帯域を出さない', !els.stats.innerHTML.includes('KB/s'), els.stats.innerHTML);

// 古い拡張ホスト（fps を送らない）でもメモリ表示は壊れない
listeners['window:message']({
  data: {type: 'resources', rssMb: 1, heapUsedMb: 2, childrenMb: 3, storageMb: 4},
});
check('fps が無ければ映像チップを出さない', !els.stats.innerHTML.includes('fps'),
  els.stats.innerHTML);

console.log('\n16) 表示幅をホストへ伝える');
check('コンテナを observe する（img は最初のフレームまで幅 0）',
  resizeObserved === els['simulator-container'],
  resizeObserved && resizeObserved.id);
sent.length = 0;
resizeCallback();
// スタブの rect は幅 300、devicePixelRatio は 2
check('CSS 幅 × DPR を送る',
  sent.some((m) => m.type === 'viewport' && m.width === 600),
  JSON.stringify(sent));
sent.length = 0;
resizeCallback();
check('同じ幅では送り直さない', !sent.some((m) => m.type === 'viewport'),
  JSON.stringify(sent));

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
