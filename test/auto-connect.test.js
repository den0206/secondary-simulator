// 自動接続のデバイス選択規則を検証する（実デバイス不要）。
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  AUTO_CONNECT_BASE_MS,
  AUTO_CONNECT_MAX_MS,
  autoConnectDelayFor,
  pickAutoConnectDevice,
} = require(path.join(ROOT, 'out/simulator/autoConnect'));

const idle = {enabled: true, currentDeviceId: null};
const booted = {id: 'B', name: 'iPhone 15', platform: 'ios', state: 'Booted'};
const shutdown = {id: 'S', name: 'iPhone 14', platform: 'ios', state: 'Shutdown'};

// 起動中のデバイスがあれば選ぶ。停止中しかなければ選ばない。
assert.strictEqual(pickAutoConnectDevice([shutdown, booted], idle), booted);
assert.strictEqual(pickAutoConnectDevice([shutdown], idle), null);
assert.strictEqual(pickAutoConnectDevice([], idle), null);

// 接続済み・設定が無効（Auto OFF / Disconnect 後）なら選ばない
assert.strictEqual(
  pickAutoConnectDevice([booted], {...idle, currentDeviceId: 'B'}),
  null
);
assert.strictEqual(
  pickAutoConnectDevice([booted], {...idle, enabled: false}),
  null
);

// 探索の間隔は連続失敗で伸びる。mobilecli が起動できない環境では毎回失敗するので、
// 5 秒固定のままだと出力チャンネル（唯一の無制限バッファ）が延々と伸びる。
assert.strictEqual(autoConnectDelayFor(0), AUTO_CONNECT_BASE_MS);
assert.strictEqual(autoConnectDelayFor(1), AUTO_CONNECT_BASE_MS * 2);
assert.strictEqual(autoConnectDelayFor(2), AUTO_CONNECT_BASE_MS * 4);
// 上限で頭打ちになり、そこから先は増えない
assert.strictEqual(autoConnectDelayFor(50), AUTO_CONNECT_MAX_MS);
assert.ok(AUTO_CONNECT_MAX_MS > AUTO_CONNECT_BASE_MS);
// 異常値でも基本間隔へ倒す（探索が止まってしまわない）
assert.strictEqual(autoConnectDelayFor(-1), AUTO_CONNECT_BASE_MS);
assert.strictEqual(autoConnectDelayFor(NaN), AUTO_CONNECT_BASE_MS);

console.log('auto-connect tests passed');
