const assert = require('node:assert/strict');
const {test} = require('node:test');
require('./helpers/vscode-stub').install();
const {AdbTouch} = require('../out/input/AdbTouch');

test('adb command failure is not reported as a successful touch', async () => {
  const touch = new AdbTouch('test');
  let sent = '';
  touch.proc = {
    stdin: {
      writable: true,
      write(text) {
        sent = text;
        queueMicrotask(() => touch.onStdout('<<ss>>1\n'));
      },
      end() {},
    },
    kill() {},
  };
  assert.equal(await touch.send(['first-command', 'second-command']), false);
  assert.match(sent, /&&/);
  touch.dispose();
});
