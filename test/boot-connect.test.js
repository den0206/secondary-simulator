const assert = require('node:assert/strict');
const {test} = require('node:test');
const stub = require('./helpers/vscode-stub').install({ProgressLocation: {Notification: 15}});
const {SimulatorWebviewProvider} = require('../out/webview/SimulatorWebviewProvider');

test('boot uses fresh state and recovers only when the device is running', async () => {
  stub.window.withProgress = async (_, run) => run();
  for (const scenario of ['already-running', 'race', 'boot', 'failure']) {
    const p = Object.create(SimulatorWebviewProvider.prototype);
    const device = {id: 'ios', name: 'iPhone', state: 'Shutdown'};
    let refreshes = 0, boots = 0, connections = 0, errors = 0;
    Object.assign(p, {
      devices: [device],
      mobileCliClient: {boot: async (id) => {
        assert.equal(id, 'ios');
        boots++;
        if (scenario === 'race' || scenario === 'failure') throw new Error('boot failed');
      }},
      refreshDevices: async () => {
        assert.equal(p.bootWaitDeviceId, 'ios');
        refreshes++;
        await p.bootAndConnect('ios'); // Repeated clicks must not start another boot.
        if (scenario === 'already-running' || (refreshes > 1 && scenario !== 'failure')) {
          device.state = 'Booted';
        }
      },
      selectDevice: async (id) => { assert.equal(id, 'ios'); connections++; },
    });
    stub.window.showErrorMessage = async () => { errors++; };
    await p.bootAndConnect('ios');
    assert.equal(boots, scenario === 'already-running' ? 0 : 1);
    assert.equal(connections, scenario === 'failure' ? 0 : 1);
    assert.equal(errors, scenario === 'failure' ? 1 : 0);
    assert.equal(p.bootWaitDeviceId, null);
  }
});
