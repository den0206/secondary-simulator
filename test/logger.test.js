// Logger.clear が OutputChannel.clear を呼ぶことを検証する。
const assert = require('assert');
const path = require('path');

let clearCalls = 0;
require('./helpers/vscode-stub').install({
  window: {
    createOutputChannel: () => ({
      appendLine() {},
      show() {},
      clear() {
        clearCalls++;
      },
      dispose() {},
    }),
  },
});

const ROOT = path.join(__dirname, '..');
const {Logger} = require(path.join(ROOT, 'out/utils/Logger'));

Logger.initialize();
Logger.clear();
assert.strictEqual(clearCalls, 1, 'OutputChannel.clear が 1 回呼ばれる');

console.log('全て成功');
