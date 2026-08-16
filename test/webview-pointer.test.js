// main.js のポインタ状態機械を DOM スタブ上で実行し、送信されるメッセージ列を検証する。
// 実ブラウザは使わず、必要最小限の DOM API だけを模擬する。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'media', 'webview', 'main.js');

const sent = [];
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
};

const sandbox = {
  console,
  acquireVsCodeApi: () => ({postMessage: (m) => sent.push(m)}),
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
  Blob: class {}, createImageBitmap: async () => ({width: 1, height: 1, close() {}}),
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

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
