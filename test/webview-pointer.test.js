// main.js のポインタ状態機械を DOM スタブ上で実行し、送信されるメッセージ列を検証する。
// 実ブラウザは使わず、必要最小限の DOM API だけを模擬する。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

require('./helpers/vscode-stub').install();

const SRC = path.join(__dirname, '..', 'media', 'webview', 'main.js');

// 拡張ホストが HTML へ埋め込むのと同じ辞書を使う（テスト用に文言を書き写さない）。
// スタブの l10n.t は原文をそのまま返すので、ここでは既定言語＝英語になる。
const STRINGS = require('../out/utils/Strings').webviewStrings();

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
    attrs: opts.attrs || {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name)
        ? this.attrs[name]
        : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
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
    focus() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    appendChild() {},
    removeChild() {},
    // removeAttribute('src') は .src も空にする（実 DOM と同じ）
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    // ビュー録画は canvas.captureStream で 1 枚ずつ出す（requestFrame）
    captureStream() {
      const track = {requestFrame() { framesRequested++; }, stop() { tracksStopped++; }};
      return {getVideoTracks: () => [track], getTracks: () => [track]};
    },
    remove() {},
    querySelector: () => ({textContent: ''}),
    getContext: () => ({
      clearRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {},
      stroke() {}, save() {}, restore() {}, arc() {}, fill() {},
      set strokeStyle(v) {}, set lineWidth(v) {}, set lineCap(v) {},
      set lineJoin(v) {}, set globalAlpha(v) {}, set fillStyle(v) {},
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
  'l10n-strings': Object.assign(makeEl('l10n-strings'), {
    textContent: JSON.stringify(STRINGS),
  }),
  'simulator-img': Object.assign(makeEl('simulator-img'), {
    naturalWidth: 0,
    naturalHeight: 0,
  }),
  overlay: makeEl('overlay'),
  'simulator-container': makeEl('simulator-container'),
  'touch-overlay': makeEl('touch-overlay'),
  countdown: makeEl('countdown'),
  device: makeEl('device'),
  'btn-home': makeEl('btn-home'),
  'btn-back': makeEl('btn-back'),
  'btn-disconnect': makeEl('btn-disconnect'),
  'btn-trail': makeEl('btn-trail'),
  'btn-record': makeEl('btn-record'),
  'btn-retry': makeEl('btn-retry'),
  'btn-logs': makeEl('btn-logs'),
  'overlay-actions': makeEl('overlay-actions'),
  lamp: makeEl('lamp'),
  stats: makeEl('stats'),
  mode: makeEl('mode'),
};

// 見た目の切り替え（端末フレーム・横向き・リソース表示）は body のクラスで持つ
const body = makeEl('body');

// applyStaticStrings が書き換える対象（HTML の data-i18n 相当）
const i18nEls = [
  makeEl('i18n-text', {attrs: {'data-i18n': 'disconnect'}}),
  makeEl('i18n-icon', {
    attrs: {'data-i18n': 'home', 'data-i18n-icon': '⌂', 'data-i18n-title': 'home'},
  }),
  makeEl('i18n-title-only', {attrs: {'data-i18n-title': 'refresh'}}),
  makeEl('i18n-unknown', {attrs: {'data-i18n': 'noSuchKey'}}),
];

// 鳴った音の数（AudioContext スタブが積む）
const tones = [];

// ---- ビュー録画のスタブ ------------------------------------------------------
// 実際の符号化はしない。**チャンクの出し方（順番・未 ack の上限・後始末）**だけを見る。
let framesRequested = 0;
let tracksStopped = 0;
const recorders = [];

class MediaRecorderStub {
  static isTypeSupported(mime) {
    return mime === 'video/mp4;codecs=avc1.42E01E';
  }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = (options || {}).mimeType;
    this.videoBitsPerSecond = (options || {}).videoBitsPerSecond;
    this.state = 'inactive';
    recorders.push(this);
  }
  start(timeslice) {
    this.state = 'recording';
    this.timeslice = timeslice;
  }
  stop() {
    this.state = 'inactive';
    if (this.onstop) this.onstop();
  }
  /** テストから 1 チャンク吐かせる。 */
  emit(base64) {
    if (this.ondataavailable) {
      this.ondataavailable({data: {size: base64.length, base64}});
    }
  }
}

class FileReaderStub {
  readAsDataURL(blob) {
    this.result = `data:video/mp4;base64,${blob.base64}`;
    setTimeout(() => this.onload && this.onload(), 0);
  }
}

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
    querySelectorAll: () => i18nEls,
    documentElement: {},
    body,
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
  // 効果音の有無を数えるためだけの最小スタブ。playTone が触る分だけ生やす。
  AudioContext: class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() {}
    createOscillator() {
      tones.push(1);
      return {
        frequency: {setValueAtTime() {}},
        connect() {}, start() {}, stop() {},
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    }
  },
  setTimeout, clearTimeout, performance, Date,
  // 心拍は実際に回さない（テストプロセスを生かし続けない）
  setInterval: () => 0,
  clearInterval: () => {},
  MediaRecorder: MediaRecorderStub,
  FileReader: FileReaderStub,
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
// 後続のケースで sent を空にするので、ここで控えておく
const initMessage = sent.find((m) => m.type === 'init');
check('init 送信', initMessage !== undefined);

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
check(
  '直結と分かる表示になる',
  els.stats.innerHTML.includes(STRINGS.direct),
  els.stats.innerHTML
);
// multipart は 1 コマごとに load が来るとは限らない。数えられていないときに
// 0fps と出すと壊れて見えるので、そのときは数字を伏せる。
// `includes('0fps')` は 10fps / 1000fps にもマッチするので使わない。
check(
  '0fps とは出さない',
  !/(^|[^0-9.])0fps/.test(els.stats.innerHTML),
  els.stats.innerHTML
);
check('直結では帯域を出さない', !els.stats.innerHTML.includes('KB/s'), els.stats.innerHTML);

// カウンタは直前で消費済み。次は描画 0 枚の直結 → 数字なしの「直結」だけ
listeners['window:message']({
  data: {type: 'resources', rssMb: 1, heapUsedMb: 2, childrenMb: 3, storageMb: 4, direct: true},
});
check(
  '描けていなければ数字を伏せて直結だけ',
  els.stats.innerHTML.includes(STRINGS.direct) &&
    !els.stats.innerHTML.includes('fps'),
  els.stats.innerHTML
);

// 古い拡張ホスト（fps を送らない）でもメモリ表示は壊れない
listeners['window:message']({
  data: {type: 'resources', rssMb: 1, heapUsedMb: 2, childrenMb: 3, storageMb: 4},
});
check('fps が無ければ映像チップを出さない', !els.stats.innerHTML.includes('fps'),
  els.stats.innerHTML);

console.log('\n15c) HTML に静的に書かれた文言を差し替える');
const [textEl, iconEl, titleEl, unknownEl] = i18nEls;
check('data-i18n で textContent を差し替える',
  textEl.textContent === STRINGS.disconnect, textEl.textContent);
check('data-i18n-icon は記号を残して後ろだけ訳す',
  iconEl.textContent === `⌂ ${STRINGS.home}`, iconEl.textContent);
check('data-i18n-title で title を差し替える',
  titleEl.title === STRINGS.refresh, String(titleEl.title));
check('text と title の両方を持つ要素も両方当たる',
  iconEl.title === STRINGS.home, String(iconEl.title));
// 辞書に無いキーは英語の原文がそのまま出る（空白にしない）
check('未知のキーはキー名のまま出す（空にしない）',
  unknownEl.textContent === 'noSuchKey', unknownEl.textContent);

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

console.log('\n17) 矢印キーを送る（以前は e.key.length===1 に一致せず捨てられていた）');
els.overlay.classList.add('hidden'); // 接続中
sent.length = 0;
for (const [dom, name] of [
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right'],
]) {
  sent.length = 0;
  listeners['document:keydown']({key: dom, preventDefault() {}});
  check(
    `${dom} → ${name}`,
    sent.some((m) => m.type === 'keypress' && m.key === name && m.special === true),
    JSON.stringify(sent)
  );
}

console.log('\n18) 文字を受ける要素にフォーカスがあるときは送らない');
// <select> の type-ahead（機種名を打って絞り込む）がデバイスにも入っていた
for (const tag of ['SELECT', 'INPUT', 'TEXTAREA', 'OPTION']) {
  sent.length = 0;
  listeners['document:keydown']({key: 'a', target: {tagName: tag}, preventDefault() {}});
  check(`${tag} 上では送らない`, sent.length === 0, JSON.stringify(sent));
}
sent.length = 0;
listeners['document:keydown']({key: 'a', target: {tagName: 'DIV'}, preventDefault() {}});
check('画面上では送る', sent.some((m) => m.type === 'keypress'), JSON.stringify(sent));

// ボタンは全部は譲らない。押した操作ボタン（Home / Rec）はフォーカスを保つので、
// 全部譲ると「Home を押したあと文字が打てない」になる。
sent.length = 0;
listeners['document:keydown']({key: 'a', target: {tagName: 'BUTTON'}, preventDefault() {}});
check(
  'ボタンにフォーカスがあっても文字は送る',
  sent.some((m) => m.type === 'keypress' && m.key === 'a'),
  JSON.stringify(sent)
);
for (const key of ['Enter', ' ']) {
  sent.length = 0;
  listeners['document:keydown']({key, target: {tagName: 'BUTTON'}, preventDefault() {}});
  check(
    `ボタンを起動する ${key === ' ' ? 'Space' : key} は譲る`,
    sent.length === 0,
    JSON.stringify(sent)
  );
}
// 画面上なら Enter は従来どおりデバイスへ届く
sent.length = 0;
listeners['document:keydown']({key: 'Enter', target: {tagName: 'DIV'}, preventDefault() {}});
check(
  '画面上の Enter は送る',
  sent.some((m) => m.type === 'keypress' && m.key === 'return'),
  JSON.stringify(sent)
);

console.log('\n19) 貼り付けは 1 回でまとめて送る');
sent.length = 0;
// Cmd+V 自体は文字として送らない（paste イベントに任せる）
listeners['document:keydown']({key: 'v', metaKey: true, preventDefault() {}});
check('Cmd+V を keypress にしない', sent.length === 0, JSON.stringify(sent));
sent.length = 0;
let readClipboard = 0;
listeners['document:paste']({
  clipboardData: {getData: () => { readClipboard++; return 'myapp://path/to/screen'; }},
  preventDefault() {},
});
check('paste を 1 通送る', sent.some((m) => m.type === 'paste'), JSON.stringify(sent));

// ここが本題。webview の clipboardData は、外部アプリでコピーした内容が
// **ひとつ前のまま**返る（VS Code 内でコピーしたときだけ最新になる）。
// 中身はホストが vscode.env.clipboard で読むので、webview は触ってはいけない。
check('clipboardData を読まない', readClipboard === 0, `読んだ回数=${readClipboard}`);
check('テキストを載せない', sent[0] && sent[0].text === undefined, JSON.stringify(sent));

// フォーム要素の上では横取りしない（デバイス選択などの通常の貼り付けを壊さない）
sent.length = 0;
listeners['document:paste']({
  target: {tagName: 'INPUT'},
  clipboardData: {getData: () => 'abc'},
  preventDefault() {},
});
check('フォーム要素では横取りしない', sent.length === 0, JSON.stringify(sent));

console.log('\n20) 録画');
sent.length = 0;
listeners['btn-record:click']();
check('Rec が record を送る', sent.some((m) => m.type === 'record'));
// 録画中かどうかはホストが持つ。webview は写すだけ
listeners['window:message']({data: {type: 'recording', active: true}});
check('録画中は見た目が変わる', els['btn-record'].classList.contains('recording'));
check('停止のラベルになる', els['btn-record'].textContent === STRINGS.recordStop,
  els['btn-record'].textContent);
tones.length = 0;
listeners['window:message']({data: {type: 'recording', active: false, ok: true}});
check('停止で戻る', !els['btn-record'].classList.contains('recording'));
check('開始のラベルに戻る', els['btn-record'].textContent === STRINGS.recordStart,
  els['btn-record'].textContent);
check('書き出せたら停止音が鳴る', tones.length > 0, `tones=${tones.length}`);

// 壊れたファイルで鳴らすと「保存できた」の合図になってしまう。
// ホストが警告を出すので、音は黙る（ok: false）。
listeners['window:message']({data: {type: 'recording', active: true}});
tones.length = 0;
listeners['window:message']({data: {type: 'recording', active: false, ok: false}});
check('書き出せなかったら停止音は鳴らさない', tones.length === 0, `tones=${tones.length}`);
check('それでも見た目は停止に戻る',
  !els['btn-record'].classList.contains('recording'));

// 開始前の秒読み。進行はホストが持つので、webview は数字と音を出して 0 で消すだけ。
tones.length = 0;
listeners['window:message']({data: {type: 'countdown', value: 3}});
check('秒読みの数字を出す', els.countdown.textContent === '3' &&
  !els.countdown.classList.contains('hidden'), els.countdown.textContent);
check('秒読みは 1 秒に 1 音', tones.length === 1, `tones=${tones.length}`);
listeners['window:message']({data: {type: 'countdown', value: 0}});
check('0 で消す', els.countdown.classList.contains('hidden'));

// 効果音は Web Audio。Node では AudioContext が無くても落ちない
listeners['window:message']({data: {type: 'sound', sound: 'shutter'}});

console.log('\n21) エラーからの復帰導線');
listeners['window:message']({data: {type: 'error', text: 'mobilecli を起動できません'}});
check('エラー文言を出す', !els.overlay.classList.contains('hidden'));
check('復帰ボタンを出す', els['overlay-actions'].classList.contains('shown'));
sent.length = 0;
listeners['btn-retry:click']();
check('Retry が retry を送る', sent.some((m) => m.type === 'retry'));
sent.length = 0;
listeners['btn-logs:click']();
check('Show Logs が showLogs を送る', sent.some((m) => m.type === 'showLogs'));
// 待機中に出すと、押しても同じ待ちに戻るだけなので出さない
listeners['window:message']({data: {type: 'connecting', name: 'iPhone 15'}});
check('待機中は出さない', !els['overlay-actions'].classList.contains('shown'));

console.log('\n22) 停止中のデバイスは起動を尋ねる');
listeners['window:message']({
  data: {
    type: 'devices',
    devices: [
      {id: 'ios-1', name: 'iPhone', state: 'Booted', platform: 'ios'},
      {id: 'ios-2', name: 'iPad', state: 'Shutdown', platform: 'ios'},
      {id: 'and-1', name: 'Pixel', state: 'Booted', platform: 'android'},
    ],
  },
});
sent.length = 0;
els.device.value = 'ios-2';
listeners['device:change']();
check(
  '停止中は bootDevice を送る（deviceChange ではない）',
  sent.some((m) => m.type === 'bootDevice' && m.deviceId === 'ios-2') &&
    !sent.some((m) => m.type === 'deviceChange'),
  JSON.stringify(sent)
);
sent.length = 0;
els.device.value = 'and-1';
listeners['device:change']();
check(
  '起動中は従来どおり deviceChange',
  sent.some((m) => m.type === 'deviceChange' && m.deviceId === 'and-1'),
  JSON.stringify(sent)
);

console.log('\n23) 見た目の設定は body のクラスで持つ');
listeners['window:message']({
  data: {type: 'settings', showDeviceFrame: false, showResourceStats: false},
});
check('端末フレームを畳む', body.classList.contains('no-frame'));
check('リソース数値を畳む', body.classList.contains('hide-stats'));
listeners['window:message']({
  data: {type: 'settings', showDeviceFrame: true, showResourceStats: true},
});
check('フレームを戻す', !body.classList.contains('no-frame'));
check('リソース数値を戻す', !body.classList.contains('hide-stats'));

console.log('\n24) 画面をタップしたらフォーカスを取る');
// pointerdown の preventDefault はフォーカス移動も止める。明示的に取らないと
// 打鍵と Cmd+V がエディタ側へ流れる（webview には keydown / paste が来ない）。
let focused = 0;
els['simulator-container'].focus = () => focused++;
fire('simulator-container', 'pointerdown', {clientX: 150, clientY: 300});
fire('simulator-container', 'pointerup', {clientX: 150, clientY: 300});
check('pointerdown でコンテナに focus する', focused === 1, `回数=${focused}`);

// ---- ここから先は非同期（チャンクの送信が FileReader を挟む）------------------
// 送信は Promise の鎖 + FileReader（setTimeout）を経由するので、数回まわす
const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function viewRecordingCases() {
  console.log('\n25) ビュー録画: 対応状況を init で報告する');
  check(
    '録れるコンテナを報告する',
    initMessage && initMessage.viewRecordingMime === 'video/mp4;codecs=avc1.42E01E',
    JSON.stringify(initMessage)
  );

  console.log('\n26) ビュー録画: 開始 → チャンク → ack → 停止');
  // 合成元のフレームが要る（1 枚も来ていなければ始めない）
  els['simulator-img'].naturalWidth = 320;
  els['simulator-img'].naturalHeight = 640;
  els['simulator-img'].src = 'data:image/jpeg;base64,AAAA';
  sent.length = 0;
  recorders.length = 0;
  framesRequested = 0;
  tracksStopped = 0;
  listeners['window:message']({
    data: {
      type: 'startViewRecording',
      mimeType: 'video/mp4;codecs=avc1.42E01E',
      bitsPerSecond: 4000000,
      timesliceMs: 1000,
      maxUnacked: 2,
    },
  });
  check('開始を返す', sent.some((m) => m.type === 'viewRecordingStarted'));
  const recorder = recorders[recorders.length - 1];
  check('timeslice を渡して刻ませる', recorder && recorder.timeslice === 1000, String(recorder && recorder.timeslice));
  check('最初の 1 枚を出す', framesRequested >= 1, String(framesRequested));

  sent.length = 0;
  recorder.emit('QUJD');
  await tick();
  const chunk = sent.find((m) => m.type === 'viewRecordingChunk');
  check('チャンクを連番で送る', chunk && chunk.seq === 0 && chunk.data === 'QUJD', JSON.stringify(chunk));

  console.log('\n27) ビュー録画: 未 ack が上限に達したら捨てずに止める');
  sent.length = 0;
  recorder.emit('QUJD'); // seq 1（未 ack 2 件目）
  await tick();
  recorder.emit('QUJD'); // 上限（2）に達しているので止まる
  await tick();
  check(
    'チャンクを捨てずにエラーで止める',
    sent.some((m) => m.type === 'viewRecordingError') &&
      sent.filter((m) => m.type === 'viewRecordingChunk').length === 1,
    JSON.stringify(sent.map((m) => m.type))
  );
  check('トラックを止める（確保したものは捨てる）', tracksStopped >= 1, String(tracksStopped));

  console.log('\n28) ビュー録画: ack が返れば続けられる');
  sent.length = 0;
  recorders.length = 0;
  listeners['window:message']({
    data: {
      type: 'startViewRecording',
      mimeType: 'video/mp4;codecs=avc1.42E01E',
      bitsPerSecond: 4000000,
      timesliceMs: 1000,
      maxUnacked: 1,
    },
  });
  const rec2 = recorders[recorders.length - 1];
  sent.length = 0;
  rec2.emit('QUJD');
  await tick();
  listeners['window:message']({data: {type: 'viewRecordingAck', seq: 0}});
  rec2.emit('REVG');
  await tick();
  check(
    'ack のぶんだけ次を送れる',
    sent.filter((m) => m.type === 'viewRecordingChunk').length === 2 &&
      !sent.some((m) => m.type === 'viewRecordingError'),
    JSON.stringify(sent.map((m) => m.type))
  );

  console.log('\n29) ビュー録画: 停止は最後のチャンクを出し切ってから返す');
  sent.length = 0;
  listeners['window:message']({data: {type: 'viewRecordingAck', seq: 1}});
  listeners['window:message']({data: {type: 'stopViewRecording'}});
  await tick();
  check('停止を返す', sent.some((m) => m.type === 'viewRecordingStopped'));
  check('レコーダーを止める', rec2.state === 'inactive');

  console.log('\n30) ビュー録画: 表示が切れたら符号化も止める');
  sent.length = 0;
  recorders.length = 0;
  listeners['window:message']({
    data: {
      type: 'startViewRecording',
      mimeType: 'video/mp4;codecs=avc1.42E01E',
      bitsPerSecond: 4000000,
      timesliceMs: 1000,
      maxUnacked: 8,
    },
  });
  const rec3 = recorders[recorders.length - 1];
  listeners['window:message']({data: {type: 'disconnected'}});
  check('切断で止まる', rec3.state === 'inactive');
}

viewRecordingCases().then(() => {
  console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
  process.exit(failures === 0 ? 0 : 1);
});
