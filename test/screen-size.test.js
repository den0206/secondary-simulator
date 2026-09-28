// 画面サイズは座標変換の元。**壊れた値や別端末の値を使わない**ことを見る
// （0 や NaN が入るとタップが原点へ飛び、旧端末の値が残ると別の位置を押す）。
const assert = require('node:assert/strict');
const {test} = require('node:test');
require('./helpers/vscode-stub').install();
const {SimulatorWebviewProvider} = require('../out/webview/SimulatorWebviewProvider');

function provider(screenSize) {
  const sent = [];
  const p = Object.create(SimulatorWebviewProvider.prototype);
  Object.assign(p, {
    currentDeviceId: 'a',
    screenSize: null,
    postMessage: (m) => sent.push(m),
    mobileCliClient: {getDeviceInfo: async () => ({device: {screenSize}})},
  });
  return {p, sent};
}

test('幅・高さが正の有限数でなければ使わない', async () => {
  for (const size of [
    undefined, {width: 0, height: 100}, {width: -1, height: 100},
    {width: NaN, height: 100}, {width: '390', height: 844}, {width: 390},
  ]) {
    const {p, sent} = provider(size);
    const error = await p.applyScreenSize('a');
    assert.ok(error instanceof Error, JSON.stringify(size));
    assert.equal(p.screenSize, null);
    assert.equal(sent.length, 0);
  }
});

test('正しい値は保持して webview へも送る', async () => {
  const {p, sent} = provider({width: 390, height: 844});
  assert.equal(await p.applyScreenSize('a'), null);
  assert.deepEqual(p.screenSize, {width: 390, height: 844});
  assert.deepEqual(sent, [{type: 'screenSize', width: 390, height: 844}]);
});

test('遅れて返った旧端末の値で上書きしない', async () => {
  const {p} = provider({width: 1, height: 1});
  p.currentDeviceId = 'b';
  p.screenSize = {width: 390, height: 844};
  await p.applyScreenSize('a');
  assert.deepEqual(p.screenSize, {width: 390, height: 844});
});
