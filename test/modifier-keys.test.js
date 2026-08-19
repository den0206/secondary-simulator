// 修飾キー付きの入力（Cmd+A / Ctrl+C など）が HID の keyDown/keyUp へ落ちることを検証する。
//
// 要点は 3 つ:
//   - text コマンドは使わない（先頭に Shift の捨てイベントを送るため、Cmd 押下中だと
//     別の組み合わせが成立する。src/input/InputBackend.ts のコメント参照）
//   - 押した修飾キーは必ず離す（残ると以降の入力が全て Cmd 付きになる）
//   - WDA 経路では送らない（device.io.text は修飾キーを扱えない）
require('./helpers/vscode-stub').install();

const {
  SimulatorInputController,
} = require('../out/input/SimulatorInputController');
const {
  HidModifier,
  usageForAsciiChar,
} = require('../out/input/InputBackend');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

const calls = [];
const fakeClient = {
  inputText: async (_id, text) => calls.push(['wda:text', text]),
  tap: async () => calls.push(['wda:tap']),
  gesture: async () => calls.push(['wda:gesture']),
  pressButton: async () => calls.push(['wda:button']),
};

function makeController() {
  const controller = new SimulatorInputController({
    deviceId: 'UDID',
    platform: 'ios',
    type: 'simulator',
    mobileCliClient: fakeClient,
    getScreenSize: () => ({width: 100, height: 200}),
    sidecarBinaryPath: '/nonexistent',
    preferWdaKeys: () => false,
  });
  // init() はサイドカーが無いと WDA を選ぶので HID 主経路を直接作る
  controller.primary = {
    kind: 'hid',
    text: async (v) => calls.push(['text', v]),
    key: async (usage, down) => calls.push([down ? 'keyDown' : 'keyUp', usage]),
    modifier: async (bit, down) =>
      calls.push([down ? 'modDown' : 'modUp', bit]),
    touchDown: async () => {},
    touchMove: async () => {},
    touchUp: async () => {},
    button: async () => {},
    dispose() {},
  };
  return controller;
}

async function main() {
  console.log('1) usageForAsciiChar が native の表と一致する');
  check('a → 0x04', usageForAsciiChar('a').usage === 0x04);
  check('z → 0x1d', usageForAsciiChar('z').usage === 0x1d);
  check(
    'A → 0x04 かつ shift',
    usageForAsciiChar('A').usage === 0x04 && usageForAsciiChar('A').shift === true
  );
  check('1 → 0x1e', usageForAsciiChar('1').usage === 0x1e);
  check('9 → 0x26', usageForAsciiChar('9').usage === 0x26);
  check('0 → 0x27', usageForAsciiChar('0').usage === 0x27);
  check('space → 0x2c', usageForAsciiChar(' ').usage === 0x2c);
  check('. → 0x37', usageForAsciiChar('.').usage === 0x37);
  check('未対応の文字は undefined', usageForAsciiChar('あ') === undefined);
  check('複数文字は undefined', usageForAsciiChar('ab') === undefined);

  console.log('\n2) Cmd+A は modifier で挟んだ keyDown/keyUp になる');
  const c = makeController();
  calls.length = 0;
  await c.keypress('a', false, ['command']);
  check(
    'modDown(20) → keyDown(4) → keyUp(4) → modUp(20)',
    JSON.stringify(calls) ===
      JSON.stringify([
        ['modDown', HidModifier.Command],
        ['keyDown', 0x04],
        ['keyUp', 0x04],
        ['modUp', HidModifier.Command],
      ]),
    JSON.stringify(calls)
  );
  check('text コマンドは使わない', !calls.some((x) => x[0] === 'text'));

  console.log('\n3) 複数の修飾キーは逆順で離す');
  calls.length = 0;
  await c.keypress('c', false, ['command', 'shift']);
  const order = calls.map((x) => `${x[0]}:${x[1]}`);
  check(
    'Command→Shift の順に押し、Shift→Command の順に離す',
    JSON.stringify(order) ===
      JSON.stringify([
        `modDown:${HidModifier.Command}`,
        `modDown:${HidModifier.Shift}`,
        'keyDown:6',
        'keyUp:6',
        `modUp:${HidModifier.Shift}`,
        `modUp:${HidModifier.Command}`,
      ]),
    JSON.stringify(order)
  );

  console.log('\n4) 大文字は指定が無くても Shift が付く');
  calls.length = 0;
  await c.keypress('C', false, ['command']);
  check(
    'Shift を補う',
    calls.some((x) => x[0] === 'modDown' && x[1] === HidModifier.Shift),
    JSON.stringify(calls)
  );
  check(
    '押した数と離した数が一致する',
    calls.filter((x) => x[0] === 'modDown').length ===
      calls.filter((x) => x[0] === 'modUp').length,
    JSON.stringify(calls)
  );

  console.log('\n5) 同じ修飾キーを二重に押さない');
  calls.length = 0;
  await c.keypress('C', false, ['command', 'shift', 'shift']);
  check(
    'Shift の押下は 1 回',
    calls.filter((x) => x[0] === 'modDown' && x[1] === HidModifier.Shift)
      .length === 1,
    JSON.stringify(calls)
  );

  console.log('\n6) 特殊キーにも修飾キーを付けられる');
  calls.length = 0;
  await c.keypress('delete', true, ['command']);
  check(
    'Cmd+Backspace は usage 0x2a',
    calls.some((x) => x[0] === 'keyDown' && x[1] === 0x2a),
    JSON.stringify(calls)
  );

  console.log('\n7) 途中で失敗しても修飾キーを離す');
  const failing = makeController();
  const modCalls = [];
  failing.primary = {
    kind: 'hid',
    text: async () => {},
    key: async () => {
      throw new Error('HID が落ちた');
    },
    modifier: async (bit, down) => modCalls.push([down ? 'down' : 'up', bit]),
    touchDown: async () => {},
    touchMove: async () => {},
    touchUp: async () => {},
    button: async () => {},
    dispose() {},
  };
  let threw = false;
  try {
    await failing.keypress('a', false, ['command']);
  } catch {
    threw = true;
  }
  check('エラーは伝播する', threw);
  check(
    '押しっぱなしにならない',
    JSON.stringify(modCalls) ===
      JSON.stringify([
        ['down', HidModifier.Command],
        ['up', HidModifier.Command],
      ]),
    JSON.stringify(modCalls)
  );

  console.log('\n8) 未対応の文字は何も送らない');
  calls.length = 0;
  await c.keypress('あ', false, ['command']);
  check('送信ゼロ', calls.length === 0, JSON.stringify(calls));

  console.log('\n9) WDA 経路では送らない（扱えないので握り潰す）');
  calls.length = 0;
  // primary を差し替えず init も呼ばないので primary は WDA フォールバックのまま
  const wdaOnly = new SimulatorInputController({
    deviceId: 'UDID',
    platform: 'android',
    type: 'emulator',
    mobileCliClient: fakeClient,
    getScreenSize: () => ({width: 100, height: 200}),
    sidecarBinaryPath: '/nonexistent',
  });
  await wdaOnly.keypress('a', false, ['command']);
  check('WDA へ text を送らない', calls.length === 0, JSON.stringify(calls));

  console.log('\n10) 修飾キー無しは従来どおり text へ流れる');
  calls.length = 0;
  await c.keypress('a');
  check(
    'text で送る',
    JSON.stringify(calls) === JSON.stringify([['text', 'a']]),
    JSON.stringify(calls)
  );
  calls.length = 0;
  await c.keypress('a', false, []);
  check(
    '空配列も従来どおり',
    JSON.stringify(calls) === JSON.stringify([['text', 'a']]),
    JSON.stringify(calls)
  );
  wdaOnly.dispose();

  console.log('\n11) 矢印キーは HID usage として送る');
  // usage は元から InputBackend にあったのに specialUsage に載っていなかったため、
  // webview から送っても text 経路へ落ちて何も起きなかった。
  const {HidUsage} = require('../out/input/InputBackend');
  for (const [name, usage] of [
    ['up', HidUsage.ArrowUp],
    ['down', HidUsage.ArrowDown],
    ['left', HidUsage.ArrowLeft],
    ['right', HidUsage.ArrowRight],
  ]) {
    calls.length = 0;
    await c.keypress(name, true);
    check(
      `${name} → keyDown/keyUp 0x${usage.toString(16)}`,
      JSON.stringify(calls) ===
        JSON.stringify([['keyDown', usage], ['keyUp', usage]]),
      JSON.stringify(calls)
    );
  }
  // 修飾キー付き（Cmd+→ で行末へ、など）も組み合わせとして通る
  calls.length = 0;
  await c.keypress('right', true, ['command']);
  check(
    'Cmd+→ は修飾キーで挟む',
    JSON.stringify(calls) ===
      JSON.stringify([
        ['modDown', HidModifier.Command],
        ['keyDown', HidUsage.ArrowRight],
        ['keyUp', HidUsage.ArrowRight],
        ['modUp', HidModifier.Command],
      ]),
    JSON.stringify(calls)
  );

  console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
