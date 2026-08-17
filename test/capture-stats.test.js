// captureRate / shouldRestartCapture の検証。vscode に触らない純粋関数。
const assert = require('node:assert');
require('./helpers/vscode-stub').install();

const {captureRate, shouldRestartCapture} = require('../out/capture/CaptureStats');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name} — ${e.message}`);
    failures++;
  }
}

console.log('1) 取り込みレートの集計');

check('30 フレーム / 1 秒 → 30fps', () => {
  assert.strictEqual(captureRate(30, 0, 1000).fps, 30);
});

check('30 秒の集計期間でも毎秒へ直す', () => {
  assert.strictEqual(captureRate(900, 0, 30_000).fps, 30);
});

check('静止画面は 0.x fps を潰さない', () => {
  // 30 秒で 3 枚 = 0.1fps。整数に丸めると「止まっている」と見分けが付かなくなる
  assert.strictEqual(captureRate(3, 0, 30_000).fps, 0.1);
});

check('帯域は KB/s（base64 の文字数で数える）', () => {
  // 30 秒で 30MB → 1024KB/s
  assert.strictEqual(captureRate(0, 1024 * 1024 * 30, 30_000).kbps, 1024);
});

check('期間 0 は測れていないので 0 を返す（Infinity にしない）', () => {
  assert.deepStrictEqual(captureRate(10, 1000, 0), {fps: 0, kbps: 0});
});

check('負の期間・NaN でも 0', () => {
  assert.deepStrictEqual(captureRate(10, 1000, -5), {fps: 0, kbps: 0});
  assert.deepStrictEqual(captureRate(10, 1000, NaN), {fps: 0, kbps: 0});
});

check('フレーム 0 でも例外にならない', () => {
  assert.deepStrictEqual(captureRate(0, 0, 30_000), {fps: 0, kbps: 0});
});

console.log('\n2) 設定変更で取り込みを張り直すか');

// affectsConfiguration の代わり。渡されたキーだけ true を返す。
const changed = (...keys) => (section) => keys.includes(section);

check('captureFps は張り直す', () => {
  assert.strictEqual(
    shouldRestartCapture(changed('secondarySimulator.captureFps')),
    true
  );
});

check('captureMaxWidth / streamQuality も張り直す', () => {
  for (const key of [
    'secondarySimulator.captureMaxWidth',
    'secondarySimulator.streamQuality',
    'secondarySimulator.streamScale',
    'secondarySimulator.captureSource',
    'secondarySimulator.directStream',
  ]) {
    assert.strictEqual(shouldRestartCapture(changed(key)), true, key);
  }
});

check('autoConnect では張り直さない（Auto ボタンで画面を切らない）', () => {
  assert.strictEqual(
    shouldRestartCapture(changed('secondarySimulator.autoConnect')),
    false
  );
});

check('logLevel / keyInput でも張り直さない', () => {
  assert.strictEqual(
    shouldRestartCapture(changed('secondarySimulator.logLevel')),
    false
  );
  assert.strictEqual(
    shouldRestartCapture(changed('secondarySimulator.keyInput')),
    false
  );
});

check('何も変わっていなければ張り直さない', () => {
  assert.strictEqual(shouldRestartCapture(changed()), false);
});

check('判定できないとき（イベント無し）は従来どおり張り直す', () => {
  assert.strictEqual(shouldRestartCapture(undefined), true);
});

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
