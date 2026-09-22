const assert = require('node:assert/strict');
const {test} = require('node:test');
require('./helpers/vscode-stub').install();
const {SimulatorWebviewProvider} = require('../out/webview/SimulatorWebviewProvider');

test('a late connection attempt cannot replace the newest input target', async () => {
  let releaseA;
  const waitA = new Promise((resolve) => { releaseA = resolve; });
  const a = {id: 'a', name: 'A', state: 'Booted', platform: 'android', type: 'emulator'};
  const b = {...a, id: 'b', name: 'B'};
  const p = Object.create(SimulatorWebviewProvider.prototype);
  const starts = [];
  Object.assign(p, {
    connectionGeneration: 0, currentDeviceId: null, inputController: null,
    devices: [a, b], recording: null, recordingStart: null, screenSize: null,
    softwareKeyboards: new Set(), mobileCliClient: {}, stopCapture() {},
    clearInputReleaseTimer() {}, postMessage() {}, setStatus() {},
    applyScreenSize: async (id) => { if (id === 'a') await waitA; return null; },
    resolveSidecarPath: () => '/not-used',
    startDisplayForDevice: async (id) => starts.push(id),
    refreshDeviceSettings: async () => {},
  });
  const first = p.startCaptureForDevice('a', a);
  await p.startCaptureForDevice('b', b);
  releaseA();
  await first;
  assert.equal(p.currentDeviceId, 'b');
  assert.equal(p.inputController.opts.deviceId, 'b');
  assert.deepEqual(starts, ['b']);
  p.inputController.dispose();
});
