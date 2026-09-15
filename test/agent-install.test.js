// 端末側 agent（mobilecli の XCTest runner）の導入を促す経路を検証する。
//
// **mobilecli は自動で入れない。** `device.info` / `device.screenshot` /
// `device.io.*` は未導入だと `agent is not installed …` で失敗し、agent は
// シミュレータ 1 台ごとなので**新しい端末では必ず未導入から始まる**。
// 入っていないと Shot が撮れず、iOS 27 では Home も効かない
// （HID の Home が届かない。docs/ios-hid-injection.md）。
//
// 要点は「黙って何も起きない」を作らないこと。接続時に［後で］を押した人が
// あとで Home / Shot を押したら、**もう一度尋ねる**。
const assert = require('node:assert/strict');
const {test} = require('node:test');
// **`install()` に渡してから provider を require する。** コンパイル後の
// `__importStar` が require 時点でモジュールのコピーを作るので、あとから
// `stub.Uri = …` と足しても provider 側には見えない（`window` のように既存の
// オブジェクトの中身を差し替えるぶんは効く）。
const stub = require('./helpers/vscode-stub').install({
  ProgressLocation: {Notification: 15},
  Uri: {joinPath: (...parts) => parts.join('/')},
});
const {
  SimulatorWebviewProvider,
} = require('../out/webview/SimulatorWebviewProvider');

const MISSING = new Error(
  "error starting agent: agent is not installed, use 'mobilecli agent install --device X' to install it"
);

/** 通知の応答を差し替えつつ、聞かれた回数と導入した回数を数える。 */
function harness({answer, installFails = false} = {}) {
  const state = {asked: 0, installed: 0, errors: 0, informed: 0};
  stub.window.showWarningMessage = async (_message, ...items) => {
    state.asked++;
    return answer === 'install' ? items[0] : answer === 'later' ? items[1] : undefined;
  };
  stub.window.showErrorMessage = async () => {
    state.errors++;
  };
  stub.window.showInformationMessage = async () => {
    state.informed++;
  };
  stub.window.withProgress = async (_options, run) => run();

  const p = Object.create(SimulatorWebviewProvider.prototype);
  Object.assign(p, {
    agentPrompted: new Set(),
    currentDeviceId: 'ios',
    devices: [{id: 'ios', name: 'iPhone'}],
    mobileCliServer: {
      installAgent: async (id) => {
        assert.equal(id, 'ios');
        state.installed++;
        if (installFails) throw new Error('install boom');
      },
    },
  });
  return {p, state};
}

test('agent 未導入のときだけ尋ねる', async () => {
  const {p, state} = harness({answer: 'install'});
  // 関係ないエラーでは尋ねない（どんな失敗でも通知が出る、を作らない）
  assert.equal(await p.ensureAgent('ios', new Error('screen size missing')), false);
  assert.equal(state.asked, 0);

  assert.equal(await p.ensureAgent('ios', MISSING), true);
  assert.equal(state.asked, 1);
  assert.equal(state.installed, 1);
});

test('接続時は端末 1 台につき 1 回しか尋ねない（自動接続で積み上げない）', async () => {
  const {p, state} = harness({answer: 'later'});
  await p.ensureAgent('ios', MISSING);
  await p.ensureAgent('ios', MISSING);
  await p.ensureAgent('ios', MISSING);
  assert.equal(state.asked, 1);
  // 別の端末は別に尋ねる
  await p.ensureAgent('ios2', MISSING);
  assert.equal(state.asked, 2);
});

test('［後で］のあとでも、押された操作からは尋ね直す', async () => {
  const {p, state} = harness({answer: 'later'});
  await p.ensureAgent('ios', MISSING); // 接続時
  assert.equal(state.asked, 1);
  // Home / Shot からの呼び出し（explicit）は絞りの対象外
  await p.ensureAgent('ios', MISSING, true);
  assert.equal(state.asked, 2);
});

test('導入に失敗したら次も尋ねる（一度きりにしない）', async () => {
  const {p, state} = harness({answer: 'install', installFails: true});
  assert.equal(await p.ensureAgent('ios', MISSING), false);
  assert.equal(state.errors, 1, 'エラーを見せる');
  assert.equal(p.agentPrompted.has('ios'), false, '絞りを外す');
  assert.equal(await p.ensureAgent('ios', MISSING), false);
  assert.equal(state.asked, 2);
});

test('Home は未導入で落ちたら導入してやり直す', async () => {
  const {p, state} = harness({answer: 'install'});
  let calls = 0;
  p.inputController = {
    home: async () => {
      calls++;
      if (calls === 1) throw MISSING;
    },
  };
  await p.pressHome();
  assert.equal(state.installed, 1);
  assert.equal(calls, 2, '導入後に 1 回だけやり直す');
});

test('Home で断られたら元のエラーを投げる（黙って飲まない）', async () => {
  const {p, state} = harness({answer: 'later'});
  p.inputController = {home: async () => { throw MISSING; }};
  await assert.rejects(() => p.pressHome(), /agent is not installed/);
  assert.equal(state.installed, 0);
});

test('Shot は導入したらそこで終わる（黒い画像を保存しない）', async () => {
  // 導入直後は runner の起動で端末画面が数秒黒くなる。続けて撮ると黒い画像が
  // 保存されるので、撮り直しはユーザーに押してもらう。
  const {p, state} = harness({answer: 'install'});
  let calls = 0;
  p.mobileCliClient = {
    screenshot: async () => {
      calls++;
      throw MISSING;
    },
  };
  let dialogs = 0;
  p.defaultSaveDir = () => 'dir';
  stub.window.showSaveDialog = async () => {
    dialogs++;
    return null;
  };
  await p.saveScreenshot();
  assert.equal(state.installed, 1, '導入はする');
  assert.equal(calls, 1, '撮り直さない');
  assert.equal(dialogs, 0, '保存ダイアログを出さない');
  assert.equal(state.informed, 1, 'もう一度押すよう伝える');
  assert.equal(state.errors, 0, '失敗としては見せない');
});

test('Shot で断られたらエラーを見せる', async () => {
  const {p, state} = harness({answer: 'later'});
  p.mobileCliClient = {screenshot: async () => { throw MISSING; }};
  p.defaultSaveDir = () => 'dir';
  stub.window.showSaveDialog = async () => null;
  await p.saveScreenshot();
  assert.equal(state.installed, 0);
  assert.equal(state.errors, 1);
  assert.equal(state.informed, 0);
});

test('関係ない失敗では agent を入れない', async () => {
  const {p, state} = harness({answer: 'install'});
  p.inputController = {home: async () => { throw new Error('port lost'); }};
  await assert.rejects(() => p.pressHome(), /port lost/);
  assert.equal(state.asked, 0);
  assert.equal(state.installed, 0);
});
