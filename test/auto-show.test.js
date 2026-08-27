// デバッグ開始でサイドバーを出す条件を検証する（VS Code 不要）。
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {shouldAutoShow, DEFAULT_AUTO_SHOW_DEBUG_TYPES} = require(
  path.join(ROOT, 'out/simulator/autoShow')
);

const hidden = {
  enabled: true,
  types: DEFAULT_AUTO_SHOW_DEBUG_TYPES,
  visible: false,
};

// 既定の種別（Flutter は iOS / Android どちらでも "dart"）では出す
assert.strictEqual(shouldAutoShow('dart', hidden), true);
assert.strictEqual(shouldAutoShow('reactnative', hidden), true);
assert.strictEqual(shouldAutoShow('android', hidden), true);
assert.strictEqual(shouldAutoShow('sweetpad-lldb', hidden), true);

// モバイル以外のデバッグでは出さない（この拡張は Flutter 専用ではないので絞る）
assert.strictEqual(shouldAutoShow('node', hidden), false);
assert.strictEqual(shouldAutoShow('go', hidden), false);

// 表示中なら何もしない（フォーカスを動かさないため）
assert.strictEqual(shouldAutoShow('dart', {...hidden, visible: true}), false);

// 設定が OFF なら出さない
assert.strictEqual(shouldAutoShow('dart', {...hidden, enabled: false}), false);

// 空配列は「種別で絞らない」
assert.strictEqual(shouldAutoShow('node', {...hidden, types: []}), true);

// 手書きの設定を拾えるよう、前後の空白と大小文字は吸収する
assert.strictEqual(shouldAutoShow('Dart', {...hidden, types: [' dart ']}), true);
assert.strictEqual(shouldAutoShow('dart', {...hidden, types: ['  ']}), true);

// 既定値は package.json と揃っていること（片方だけ直すと設定画面と食い違う）
const pkg = require(path.join(ROOT, 'package.json'));
assert.deepStrictEqual(
  pkg.contributes.configuration.properties['secondarySimulator.autoShowDebugTypes']
    .default,
  DEFAULT_AUTO_SHOW_DEBUG_TYPES
);
// デバッグ開始を聞くには、ビューを開く前に拡張が起きている必要がある
assert.ok(pkg.activationEvents.includes('onDebug'));

console.log('auto-show tests passed');
