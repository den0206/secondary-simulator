// 端末設定が組み立てるコマンド列を検証する。実端末も xcrun / adb も要らない。
//
// **`adb shell` の引数は端末側の sh が解釈する**（CLAUDE.md「値はホスト側で検証
// してから渡す」）。ここが素通りすると、検証していない値が端末のシェルへ届く。
// iOS は devicectl を先に試し、Simulator だけ simctl へ落ちる順序も見る。
const assert = require('node:assert/strict');
const {test} = require('node:test');
const childProcess = require('node:child_process');
require('./helpers/vscode-stub').install();

/** 実行されたコマンド。`fail` に一致したものは失敗させる。 */
const calls = [];
let fail = () => false;
let reply = () => '';
// DeviceSettings は読み込み時に promisify(execFile) を掴むので、その前に差し替える
childProcess.execFile = (file, args, _options, callback) => {
  calls.push([file, ...args]);
  if (fail(file, args)) callback(new Error('failed'));
  else callback(null, {stdout: reply(file, args)});
};

const {AdbTouch} = require('../out/input/AdbTouch');
AdbTouch.findAdb = () => '/adb';
AdbTouch.resolveSerial = async () => 'emulator-5554';

const {
  readDeviceSettings,
  setAppearance,
  setLiquidGlassOpacity,
  setLocation,
  setTextSize,
} = require('../out/simulator/DeviceSettings');

const android = {id: 'avd', platform: 'android', type: 'emulator'};
const sim = {id: 'SIM', platform: 'ios', type: 'simulator', runtime: 'iOS 26.0'};
const phone = {id: 'PHONE', platform: 'ios', type: 'real', runtime: 'iOS 26.0'};

function reset() {
  calls.length = 0;
  fail = () => false;
  reply = () => '';
}

const adb = (...args) => ['/adb', '-s', 'emulator-5554', 'shell', ...args];

test('Android: 外観と文字サイズは決まった語と表の数値だけを渡す', async () => {
  reset();
  await setAppearance(android, 'dark');
  await setAppearance(android, 'light');
  await setTextSize(android, 'extra-extra-extra-large');
  assert.deepEqual(calls, [
    adb('cmd', 'uimode', 'night', 'yes'),
    adb('cmd', 'uimode', 'night', 'no'),
    adb('settings', 'put', 'system', 'font_scale', '1.5'),
  ]);
});

test('表に無い文字サイズは端末へ何も送らない', async () => {
  reset();
  await assert.rejects(setTextSize(android, 'huge; reboot'));
  await assert.rejects(setTextSize(sim, 'huge'));
  assert.deepEqual(calls, []);
});

test('Liquid Glass は iOS 26+ かつ 0..1 の数値だけ', async () => {
  reset();
  for (const value of [-0.1, 1.1, NaN, Infinity]) {
    await assert.rejects(setLiquidGlassOpacity(sim, value));
  }
  await assert.rejects(setLiquidGlassOpacity({...sim, runtime: 'iOS 18.0'}, 0.5));
  await assert.rejects(setLiquidGlassOpacity(android, 0.5));
  assert.deepEqual(calls, []);
  await setLiquidGlassOpacity(sim, 0.5);
  assert.deepEqual(calls, [[
    'xcrun', 'devicectl', 'device', 'settings', 'appearance',
    '--device', 'SIM', '--liquid-glass-opacity', '0.5',
  ]]);
});

test('iOS: devicectl が失敗したら Simulator だけ simctl へ落ちる', async () => {
  reset();
  fail = (_file, args) => args[0] === 'devicectl';
  await setAppearance(sim, 'dark');
  assert.deepEqual(calls.at(-1), ['xcrun', 'simctl', 'ui', 'SIM', 'appearance', 'dark']);

  calls.length = 0;
  await assert.rejects(setAppearance(phone, 'dark'));
  assert.equal(calls.length, 1, '実機は simctl を試さない');
});

test('模擬位置: Android は gps の test provider を張り替え、解除では外すだけ', async () => {
  reset();
  await setLocation(android, {latitude: 35.5, longitude: -139.25});
  assert.deepEqual(calls, [
    adb('cmd', 'location', 'providers', 'remove-test-provider', 'gps'),
    adb('cmd', 'location', 'providers', 'add-test-provider', 'gps'),
    adb('cmd', 'location', 'providers', 'set-test-provider-enabled', 'gps', 'true'),
    adb('cmd', 'location', 'providers', 'set-test-provider-location', 'gps',
      '--location', '35.5,-139.25'),
  ]);

  // 未設定での remove は失敗するが、解除そのものは成功として返す
  calls.length = 0;
  fail = (_file, args) => args.includes('remove-test-provider');
  await setLocation(android, null);
  assert.equal(calls.length, 1);
});

test('模擬位置: iOS は devicectl → simctl の順', async () => {
  reset();
  fail = (_file, args) => args[0] === 'devicectl';
  await setLocation(sim, {latitude: 1, longitude: 2});
  await setLocation(sim, null);
  assert.deepEqual(calls.filter((c) => c[1] === 'simctl'), [
    ['xcrun', 'simctl', 'location', 'SIM', 'set', '1,2'],
    ['xcrun', 'simctl', 'location', 'SIM', 'clear'],
  ]);
});

test('読み取り: Android の出力を外観と最寄りの文字サイズへ畳む', async () => {
  reset();
  reply = (_file, args) =>
    args.includes('uimode') ? 'Night mode: yes' : '1.14';
  assert.deepEqual(await readDeviceSettings(android), {
    liquidGlass: false,
    appearance: 'dark',
    textSize: 'extra-large',
  });
});

test('読み取り: simctl が失敗しても devicectl の値で埋める', async () => {
  reset();
  fail = (_file, args) => args[0] === 'simctl';
  reply = () => JSON.stringify({result: {
    userInterfaceStyle: 'light', contentSize: 'small', liquidGlassOpacity: 0.3,
  }});
  assert.deepEqual(await readDeviceSettings(sim), {
    liquidGlass: true,
    appearance: 'light',
    textSize: 'small',
    liquidGlassOpacity: 0.3,
  });
});
