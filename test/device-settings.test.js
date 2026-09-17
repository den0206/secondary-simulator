const assert = require('assert');
require('./helpers/vscode-stub').install();
const {
  iosMajorVersion,
  parseCoordinates,
  TEXT_SIZES,
} = require('../out/simulator/DeviceSettings');

assert.strictEqual(iosMajorVersion('iOS 26.1'), 26);
assert.strictEqual(iosMajorVersion('17.5'), 17);
assert.strictEqual(iosMajorVersion('unknown'), null);

assert.deepStrictEqual(parseCoordinates('35.681236, 139.767125'), {
  latitude: 35.681236,
  longitude: 139.767125,
});
assert.deepStrictEqual(parseCoordinates('-90, -180'), {
  latitude: -90,
  longitude: -180,
});
assert.strictEqual(parseCoordinates('91, 0'), null);
assert.strictEqual(parseCoordinates('35.6;139.7'), null);
assert.strictEqual(TEXT_SIZES.length, 7);

console.log('device settings tests passed');
