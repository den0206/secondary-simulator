// main.js のポインタ状態機械を DOM スタブ上で実行し、送信されるメッセージ列を検証する。
// 実ブラウザは使わず、必要最小限の DOM API だけを模擬する。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'media', 'webview', 'main.js');

const sent = [];
let lastBlobBytes = null; // renderFrame が Blob へ渡した最後のバイト列
let webviewState; // vscode.getState/setState の保存先
const listeners = {}; // "elementId:event" -> handler

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
    addEventListener(ev, fn) { listeners[`${id}:${ev}`] = fn; },
    removeEventListener() {},
    getBoundingClientRect: () =>
      opts.rect || {left: 0, top: 0, width: 300, height: 600},
    setPointerCapture() {},
    releasePointerCapture() {},
    appendChild() {},
    removeChild() {},
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
    src: '',
  };
  return el;
}

const els = {
  'simulator-canvas': makeEl('simulator-canvas'),
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
  },
  getComputedStyle: () => ({getPropertyValue: () => '#007acc'}),
  requestAnimationFrame: (fn) => { fn(); return 1; },
  cancelAnimationFrame: () => {},
  setTimeout, clearTimeout, performance,
  atob: (b64) => Buffer.from(b64, 'base64').toString('latin1'),
  // renderFrame が Blob に渡したバイト列を覗けるようにしておく
  Blob: class {
    constructor(parts) {
      this.parts = parts;
      lastBlobBytes = parts && parts[0] ? parts[0] : null;
    }
  },
  createImageBitmap: async () => ({width: 1, height: 1, close() {}}),
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

console.log('\n6) streamUrl で img 直結に切り替わる');
sent.length = 0;
listeners['window:message']({data: {type: 'streamUrl', url: 'http://localhost:12200/stream?device=X'}});
check('img.src が設定される', els['simulator-img'].src.includes('/stream?device=X'),
  els['simulator-img'].src);
check('最初のフレームまで待機表示', !els.overlay.classList.contains('hidden'));
check('canvas が隠れる', els['simulator-canvas'].style.display === 'none');
// 最初のフレーム到達（<img> の onload 相当）
els['simulator-img'].onload();
check('onload で img が表示される', els['simulator-img'].style.display === 'block');
check('onload でオーバーレイが消える', els.overlay.classList.contains('hidden'));

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
els['simulator-img'].onload();
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
listeners['window:message']({data: {type: 'frame', data: new Uint8Array([1])}});
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

// renderFrame は非同期なので、フレーム毎に 1 tick 空けてキューを流し切る。
const tick = () => new Promise((r) => setTimeout(r, 0));

async function frameTests() {
  console.log('\n14) フレームの受け取り（base64）');

  // 拡張ホストは Buffer.toString('base64') で送る。UTF-8 として不正なバイトを含む
  // JPEG でも、復号後に 1 バイトも変わってはいけない。
  const original = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x7f, 0x80, 0xc3, 0xff, 0xd9]);
  lastBlobBytes = null;
  listeners['window:message']({
    data: {type: 'frame', encoding: 'base64', data: original.toString('base64')},
  });
  await tick();
  // VM サンドボックス側の Uint8Array なので instanceof は使えない
  check('base64 文字列をバイト列へ復号する', ArrayBuffer.isView(lastBlobBytes),
    String(lastBlobBytes && lastBlobBytes.constructor.name));
  check('復号後のバイト列が完全に一致する',
    lastBlobBytes && Buffer.from(lastBlobBytes).equals(original),
    lastBlobBytes && Buffer.from(lastBlobBytes).toString('hex'));

  // 旧形式（配列 / Buffer 風オブジェクト）も落とさない
  lastBlobBytes = null;
  listeners['window:message']({data: {type: 'frame', data: {type: 'Buffer', data: [1, 2, 3]}}});
  await tick();
  check('Buffer 風オブジェクトも受け取れる',
    lastBlobBytes && Buffer.from(lastBlobBytes).equals(Buffer.from([1, 2, 3])),
    lastBlobBytes && Buffer.from(lastBlobBytes).toString('hex'));

  lastBlobBytes = null;
  listeners['window:message']({data: {type: 'frame', data: new Uint8Array([9, 8])}});
  await tick();
  check('Uint8Array も受け取れる',
    lastBlobBytes && Buffer.from(lastBlobBytes).equals(Buffer.from([9, 8])),
    lastBlobBytes && Buffer.from(lastBlobBytes).toString('hex'));
}

frameTests().then(() => {
  console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
  process.exit(failures === 0 ? 0 : 1);
});
