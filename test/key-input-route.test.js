// secondarySimulator.keyInput の経路分岐を検証する。
// キー/テキストだけ WDA へ回しても、タッチは HID のままであることが要点
// （HID のキー注入はシミュレータをハードウェアキーボード扱いにし、
//  ソフトウェアキーボードが出なくなる。docs/ios-hid-injection.md）。
require('./helpers/vscode-stub').install();

const {
  SimulatorInputController,
} = require('../out/input/SimulatorInputController');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failures++; }
}

const calls = [];
let preferWda = false;

// mobilecli の代わり。WdaBackend はこのクライアントを叩く。
const fakeClient = {
  inputText: async (_id, text) => calls.push(['wda:text', text]),
  tap: async () => calls.push(['wda:tap']),
  gesture: async () => calls.push(['wda:gesture']),
  pressButton: async (_id, button) => calls.push(['wda:button', button]),
};

const controller = new SimulatorInputController({
  deviceId: 'UDID',
  platform: 'ios',
  type: 'simulator',
  mobileCliClient: fakeClient,
  getScreenSize: () => ({width: 100, height: 200}),
  sidecarBinaryPath: '/nonexistent',
  preferWdaKeys: () => preferWda,
});

// init() はサイドカーが無いと WDA を選ぶので、HID 主経路の状態を直接作る
// （private は TypeScript のコンパイル時のみ）。
controller.primary = {
  kind: 'hid',
  text: async (v) => calls.push(['hid:text', v]),
  key: async (usage, down) => calls.push(['hid:key', usage, down]),
  touchDown: async () => calls.push(['hid:touchDown']),
  touchMove: async () => calls.push(['hid:touchMove']),
  touchUp: async () => calls.push(['hid:touchUp']),
  button: async () => calls.push(['hid:button']),
  modifier: async () => {},
  dispose() {},
};

async function main() {
  console.log('1) 既定（hid）は HID へ送る');
  calls.length = 0;
  await controller.text('abc');
  check('text は HID', JSON.stringify(calls) === JSON.stringify([['hid:text', 'abc']]),
    JSON.stringify(calls));

  console.log('\n2) keyInput=wda ならキー入力だけ WDA へ回る');
  preferWda = true;
  calls.length = 0;
  await controller.text('abc');
  check('text は WDA(inputText)',
    JSON.stringify(calls) === JSON.stringify([['wda:text', 'abc']]),
    JSON.stringify(calls));

  calls.length = 0;
  await controller.keypress('delete', true);
  check('Backspace は WDA へ \\b を送る',
    JSON.stringify(calls) === JSON.stringify([['wda:text', '\b']]),
    JSON.stringify(calls));

  console.log('\n3) タッチは常に HID（wda 指定でも降りない）');
  calls.length = 0;
  await controller.touchDown(0.5, 0.5);
  await controller.touchMove(0.5, 0.6);
  await controller.touchUp(0.5, 0.6);
  check('touch* は HID のまま',
    JSON.stringify(calls) ===
      JSON.stringify([['hid:touchDown'], ['hid:touchMove'], ['hid:touchUp']]),
    JSON.stringify(calls));

  console.log('\n4) DeviceHub の Home は agent 経由にする');
  controller.opts.version = '27.0';
  calls.length = 0;
  await controller.home();
  check('iOS 27 は WDA の HOME',
    JSON.stringify(calls) === JSON.stringify([['wda:button', 'HOME']]), JSON.stringify(calls));

  controller.opts.version = '26.0';
  calls.length = 0;
  await controller.home();
  check('旧版は HID の Home',
    JSON.stringify(calls) === JSON.stringify([['hid:button']]), JSON.stringify(calls));

  console.log('\n5) ソフトウェアキーボードの切り替え（HW キーボードの接続を外す）');
  controller.sidecar = {send: async (c) => calls.push(['sidecar', c.cmd, c.enable])};
  calls.length = 0;
  await controller.setHardwareKeyboard(false);
  check('HID 経路ならサイドカーへ hardwareKeyboard を送る',
    JSON.stringify(calls) === JSON.stringify([['sidecar', 'hardwareKeyboard', false]]),
    JSON.stringify(calls));

  controller.sidecar = null;
  let threw = false;
  await controller.setHardwareKeyboard(false).catch(() => { threw = true; });
  check('サイドカーが無ければ失敗する（WDA 経路では切り替えられない）', threw);

  console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
