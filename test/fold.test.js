// 折りたたみ端末（iPhone Duo）。実端末は要らない。
//
// 画面が 2 枚あり、点いている方を devicectl で読んでサイドカーへ渡す。**内側パネルは
// 開いた既定で UI が横に寝ている**（2007×2853 の面に rot90、UI の上端が面の左辺）ので、
// 取り込みは 270 で起こし、タップは縦の面の座標へ戻す。
const assert = require('node:assert/strict');
const {test} = require('node:test');
const stub = require('./helpers/vscode-stub').install();
const {parseFoldState} = require('../out/simulator/DeviceSettings');
const {SimulatorWebviewProvider} = require('../out/webview/SimulatorWebviewProvider');
const {SidecarCapture} = require('../out/capture/SidecarCapture');

/** `xcrun devicectl device info displays --json-output -` の形（iPhone Duo / Xcode 27.1 の実測から抜粋）。 */
function displays(openPanel) {
  const panel = (displayId, size, active, orientation) => ({
    active,
    currentOrientation: orientation,
    displayId,
    nativeSize: size,
    primary: displayId === 1,
    type: {integrated: {}},
  });
  return {
    result: {
      displays: [
        panel(1, [1398, 2034], !openPanel, 'rot0'),
        panel(3, [2007, 2853], openPanel, 'rot90'),
        {active: false, displayId: 2, nativeSize: [720, 480], type: {tvOut: {}}},
      ],
    },
  };
}

test('閉じていれば外側パネル、開いていれば内側パネルを 270 で起こす', () => {
  assert.deepEqual(parseFoldState(displays(false)), {displayId: 1, rotate: 0, open: false});
  assert.deepEqual(parseFoldState(displays(true)), {displayId: 3, rotate: 270, open: true});
});

test('画面が 1 枚の端末と読めない出力は null（ボタンを出さない）', () => {
  const single = displays(false);
  single.result.displays.splice(1, 1);
  assert.equal(parseFoldState(single), null);
  assert.equal(parseFoldState({}), null);
  assert.equal(parseFoldState(null), null);
});

/** 折りたたみ端末に繋いだ provider。 */
function provider(fold) {
  const touches = [];
  const calls = [];
  const posted = [];
  const p = Object.create(SimulatorWebviewProvider.prototype);
  const capture = Object.assign(Object.create(SidecarCapture.prototype), {
    rotations: [],
    setPanelRotation(v) { this.rotations.push(v); },
    setInteracting() {},
  });
  Object.assign(p, {
    currentDeviceId: 'D',
    devices: [{id: 'D', name: 'iPhone Duo', platform: 'ios', type: 'simulator', state: 'Booted'}],
    landscape: false,
    fold,
    currentCapture: capture,
    recorder: {active: false, isBusy: false},
    postMessage: (m) => posted.push(m),
    inputController: {
      touchDown: async (x, y) => touches.push([x, y]),
      setPanel: async (id) => calls.push(['panel', id]),
      moveHinge: async (from, to) => calls.push(['hinge', from, to]),
    },
  });
  return {p, capture, touches, calls, posted};
}

test('内側パネルのタップは縦の面の座標へ戻す（UI の上端が面の左辺）', async () => {
  const {p, touches} = provider({displayId: 3, rotate: 270, open: true});
  // 表示の左上寄り → 面の左下寄り
  await p.handleTouch('down', {x: 0.1, y: 0.2});
  assert.deepEqual(touches, [[0.2, 0.9]]);
  // 閉じた外側パネルは縦のまま
  p.fold = {displayId: 1, rotate: 0, open: false};
  await p.handleTouch('down', {x: 0.1, y: 0.2});
  assert.deepEqual(touches.at(-1), [0.1, 0.2]);
});

test('閉じる: ヒンジを 180→0 に動かし、切り替わったパネルへ合わせる', async () => {
  const {p, capture, calls, posted} = provider({displayId: 3, rotate: 270, open: true});
  // パネルの切り替えは遅れて報告される。1 回目はまだ内側
  const reads = [displays(true), displays(false)].map(parseFoldState);
  p.readFold = async () => reads.shift();
  await p.toggleFold();
  assert.deepEqual(calls, [['hinge', 180, 0], ['panel', 1]]);
  assert.deepEqual(capture.rotations, [0]);
  assert.deepEqual(p.fold, {displayId: 1, rotate: 0, open: false});
  assert.deepEqual(posted.at(-1), {type: 'fold', open: false});
});

test('折りたたみは回さない（mobilecli の回転はゲストに上書きされる）', async () => {
  let info;
  stub.window.showInformationMessage = async (m) => { info = m; };
  const sets = [];
  const {p} = provider({displayId: 3, rotate: 270, open: true});
  p.mobileCliClient = {setOrientation: async (...a) => sets.push(a)};
  await p.rotate();
  assert.deepEqual(sets, []);
  assert.equal(p.landscape, false);
  assert.match(info, /Rotation is not supported on foldable devices yet/);
});

test('録画中は開閉しない（フレームの縦横比が変わる）', async () => {
  let warning;
  stub.window.showWarningMessage = async (m) => { warning = m; };
  const {p, calls} = provider({displayId: 1, rotate: 0, open: false});
  p.recorder = {active: true, isBusy: false};
  await p.toggleFold();
  assert.deepEqual(calls, []);
  assert.match(warning, /Stop the recording before opening or closing/);
});

test('開閉に失敗したら状態を変えずに知らせる', async () => {
  let error;
  stub.window.showErrorMessage = async (m) => { error = m; };
  const {p, posted} = provider({displayId: 1, rotate: 0, open: false});
  p.inputController.moveHinge = async () => { throw new Error('nope'); };
  await p.toggleFold();
  assert.deepEqual(p.fold, {displayId: 1, rotate: 0, open: false});
  assert.deepEqual(posted, []);
  assert.match(error, /Could not open or close the device — nope/);
});
