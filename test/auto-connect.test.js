// 自動接続のデバイス選択規則を検証する（実デバイス不要）。
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {pickAutoConnectDevice} = require(
  path.join(ROOT, 'out/simulator/autoConnect')
);

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

console.log('auto-connect tests passed');
