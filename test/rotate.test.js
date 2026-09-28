// 画面回転。実端末は要らない。
//
// 回転は「表示の座標」と「端末の座標」がずれる唯一の場面。**iOS のサイドカー取り込みは
// 縦のフレームバッファを起こして見せる**ので、タップは縦の座標へ戻さないと別の場所を
// 押す（実測: iPhone 18 Pro / iOS 27 で UI の上端が面の右辺）。Android は端末ごと
// 座標系が回るので、戻すのではなく screenSize の縦横を入れ替える。
const assert = require('node:assert/strict');
const {test} = require('node:test');
const stub = require('./helpers/vscode-stub').install();
const {SimulatorWebviewProvider} = require('../out/webview/SimulatorWebviewProvider');
const {SidecarCapture} = require('../out/capture/SidecarCapture');

/** 端末と取り込みだけを持つ provider。 */
function provider({platform = 'ios', sidecar = true, client = {}} = {}) {
  const touches = [];
  const p = Object.create(SimulatorWebviewProvider.prototype);
  const capture = sidecar
    ? Object.assign(Object.create(SidecarCapture.prototype), {
        landscape: [],
        setLandscape(v) { this.landscape.push(v); },
        setInteracting() {},
      })
    : {restarted: 0};
  Object.assign(p, {
    currentDeviceId: 'D',
    devices: [{id: 'D', name: 'Phone', platform, state: 'Booted'}],
    landscape: false,
    screenSize: {width: 400, height: 900},
    currentCapture: capture,
    mobileCliClient: client,
    recorder: {active: false, isBusy: false},
    postMessage() {},
    restartDisplay: async () => { capture.restarted++; },
    inputController: {
      touchDown: async (x, y) => touches.push([x, y]),
    },
  });
  return {p, capture, touches};
}

test('iOS サイドカー取り込み: 横向きのタップは縦の面の座標へ戻す', async () => {
  const {p, touches} = provider();
  p.landscape = true;
  // 表示の左上寄り → 面の右上寄り（UI の上端が面の右辺）
  await p.handleTouch('down', {x: 0.1, y: 0.2});
  assert.deepEqual(touches, [[0.8, 0.1]]);
  // 縦なら素通し
  p.landscape = false;
  await p.handleTouch('down', {x: 0.1, y: 0.2});
  assert.deepEqual(touches.at(-1), [0.1, 0.2]);
});

test('Android: 座標は素通しで、screenSize の縦横を入れ替える', async () => {
  const {p, touches} = provider({platform: 'android', sidecar: false});
  p.landscape = true;
  await p.handleTouch('down', {x: 0.1, y: 0.2});
  assert.deepEqual(touches, [[0.1, 0.2]]);
  assert.deepEqual(p.inputScreenSize(), {width: 900, height: 400});
  p.landscape = false;
  assert.deepEqual(p.inputScreenSize(), {width: 400, height: 900});
});

test('iOS の screenSize は横でも入れ替えない（HID は縦の座標で受ける）', () => {
  const {p} = provider();
  p.landscape = true;
  assert.deepEqual(p.inputScreenSize(), {width: 400, height: 900});
});

test('回転: サイドカーは張り直さずに起こし、それ以外は取り込みを張り直す', async () => {
  const sets = [];
  const client = {setOrientation: async (id, o) => sets.push([id, o])};
  const ios = provider({client});
  await ios.p.rotate();
  await ios.p.rotate();
  assert.deepEqual(sets, [['D', 'landscape'], ['D', 'portrait']]);
  assert.deepEqual(ios.capture.landscape, [true, false]);

  const android = provider({platform: 'android', sidecar: false, client});
  await android.p.rotate();
  assert.equal(android.p.landscape, true);
  assert.equal(android.capture.restarted, 1);
});

test('回転に失敗したら向きを変えたことにしない', async () => {
  let error;
  stub.window.showErrorMessage = async (m) => { error = m; };
  const {p, capture} = provider({
    client: {setOrientation: async () => { throw new Error('nope'); }},
  });
  p.ensureAgent = async () => false;
  await p.rotate();
  assert.equal(p.landscape, false);
  assert.deepEqual(capture.landscape, []);
  assert.match(error, /Could not rotate the device — nope/);
});

test('録画中は回さない（ビュー録画の canvas は開始時の寸法で固定される）', async () => {
  let warning;
  stub.window.showWarningMessage = async (m) => { warning = m; };
  const sets = [];
  const {p, capture} = provider({client: {setOrientation: async (...a) => sets.push(a)}});
  for (const recorder of [{active: true, isBusy: false}, {active: false, isBusy: true}]) {
    p.recorder = recorder;
    await p.rotate();
  }
  assert.deepEqual(sets, []);
  assert.equal(p.landscape, false);
  assert.deepEqual(capture.landscape, []);
  assert.match(warning, /Stop the recording before rotating/);
});
