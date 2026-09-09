const assert = require('node:assert/strict');
const {test} = require('node:test');
const stub = require('./helpers/vscode-stub').install();
const {SimulatorWebviewProvider} = require('../out/webview/SimulatorWebviewProvider');
const {MobileCliClient} = require('../out/utils/MobileCliClient');

test('disconnect choices, shutdown target, recording safety and repeated clicks', async () => {
  for (const type of ['simulator', 'emulator', 'real']) {
    for (const answer of [undefined, 'Disconnect only', 'Disconnect and shut down']) {
      const calls = [];
      const p = Object.create(SimulatorWebviewProvider.prototype);
      Object.assign(p, {
        currentDeviceId: 'target', devices: [{id: 'target', name: 'Phone', type}],
        mobileCliClient: new MobileCliClient({sendJsonRpcRequest: async (...args) => calls.push(args)}),
        stopRecording: async () => calls.push('recording'),
        stopCapture: () => calls.push('capture'), disposeProxy() {}, setStatus() {},
        postMessage() {}, syncAutoConnectTimer() {},
        refreshDevices: async () => calls.push('refresh'),
      });
      stub.workspace.getConfiguration = () => ({get: (_, fallback) => fallback, update: async () => calls.push('auto')});
      stub.window.showInformationMessage = async (_, options) => {
        assert.equal(options.modal, true);
        calls.push('dialog');
        await p.disconnect(); // A second click must not create another dialog.
        return answer;
      };
      await p.disconnect();
      const cancel = type !== 'real' && answer === undefined;
      assert.equal(p.currentDeviceId, cancel ? 'target' : null);
      assert.equal(calls.includes('dialog'), type !== 'real');
      const rpc = calls.filter(Array.isArray);
      assert.deepEqual(rpc, type !== 'real' && answer === 'Disconnect and shut down'
        ? [['device.shutdown', {deviceId: 'target'}, 30000]] : []);
      if (rpc.length) {
        assert.ok(calls.indexOf('recording') < calls.indexOf(rpc[0]));
        assert.ok(calls.indexOf('refresh') > calls.indexOf(rpc[0]));
      }
      assert.equal(calls.includes('refresh'), rpc.length > 0);
      assert.equal(p.disconnectBusy, false);

      if (type === 'real') continue;
      p.currentDeviceId = 'target';
      p.recording = {};
      calls.length = 0;
      await p.disconnect();
      assert.equal(p.currentDeviceId, 'target');
      assert.ok(!calls.includes('capture'));
      assert.ok(!calls.some(Array.isArray));
      p.recording = null;
      stub.window.showInformationMessage = async () => { p.currentDeviceId = 'other'; return answer; };
      await p.disconnect();
      assert.equal(p.currentDeviceId, 'other');

      p.currentDeviceId = 'target';
      stub.window.showInformationMessage = async () => 'Disconnect and shut down';
      p.mobileCliClient.shutdown = async () => { throw new Error('failed'); };
      let error;
      stub.window.showErrorMessage = async (message) => { error = message; };
      await p.disconnect();
      assert.equal(p.currentDeviceId, null);
      assert.match(error, /could not shut down Phone/);
      assert.equal(calls.at(-1), 'refresh');
    }
  }
});
