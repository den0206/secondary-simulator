// node test/packaged-startup.device-test.js <extracted VSIX extension directory> <iOS UDID>
// Uses only packaged runtime modules; the VS Code API is the sole stub.
const assert = require('node:assert/strict');
const path = require('node:path');
require('./helpers/vscode-stub').installVerbose();
const [directory, deviceId] = process.argv.slice(2);
assert.ok(directory && deviceId, 'Pass an extracted extension directory and a booted iOS Simulator UDID');
const root = require('node:fs').realpathSync(directory);
const {MobileCliServer} = require(path.join(root, 'out/utils/MobileCliServer'));
const {MobileCliClient} = require(path.join(root, 'out/utils/MobileCliClient'));
const {JsonRpcClient} = require(path.join(root, 'out/utils/JsonRpcClient'));
const {SimulatorInputController} = require(path.join(root, 'out/input/SimulatorInputController'));
const {SidecarCapture} = require(path.join(root, 'out/capture/SidecarCapture'));
const {Logger} = require(path.join(root, 'out/utils/Logger'));
Logger.initialize();
const server = new MobileCliServer();
let controller, capture, timer;
(async () => {
  assert.ok(server.mobilecliPath.startsWith(root), 'Must resolve the packaged binary, not npx or developer dependencies');
  await server.launchServer();
  const client = new MobileCliClient(new JsonRpcClient(`http://localhost:${server.getServerPort()}`));
  const {devices} = await client.listDevices(true);
  const device = devices.find((d) => d.id === deviceId);
  assert.equal(device?.state, 'online');
  console.log('PASS: packaged server and device discovery');
  try {
    await client.getDeviceInfo(deviceId);
    console.log('PASS: device.info');
  } catch (error) {
    // A fresh simulator has no WDA; HID capture must still work.
    assert.match(error.message, /agent is not installed/);
    console.log('Confirmed: fresh device needs agent installation for WDA operations');
  }
  controller = new SimulatorInputController({
    deviceId, platform: 'ios', type: 'simulator', version: device.version,
    mobileCliClient: client, getScreenSize: () => ({width: 402, height: 874}),
    sidecarBinaryPath: path.join(root, 'native/simhid-server'),
  });
  await controller.init();
  assert.ok(controller.activeSidecar, 'Packaged HID sidecar must start');
  capture = new SidecarCapture(controller.activeSidecar, () => ({fps: 10, maxWidth: 320, quality: 0.6}));
  capture.setDevice(deviceId);
  const frame = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('No frame within 20 seconds')), 20000);
    capture.onFrame(resolve);
  });
  await capture.start();
  assert.equal(Buffer.from(await frame, 'base64').readUInt16BE(0), 0xffd8);
  console.log('PASS: packaged sidecar delivered a JPEG frame');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(timer);
  capture?.dispose();
  controller?.dispose();
  server.stopServer();
  Logger.dispose();
});
