// out/ のモジュールは Logger 経由で 'vscode' を require するが、拡張ホストの外では
// 解決できない。テストから require する前にこのスタブを差し込む。
//
//   require('./helpers/vscode-stub').install();
//
// 上書きしたい API があれば install({window: {...}}) のように部分的に渡す。
const Module = require('module');

let origLoad = null;

function defaultStub() {
  return {
    window: {
      createOutputChannel: () => ({
        appendLine() {},
        show() {},
        dispose() {},
      }),
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined,
    },
    workspace: {
      getConfiguration: () => ({get: (_key, fallback) => fallback}),
    },
    ConfigurationTarget: {Global: 1, Workspace: 2, WorkspaceFolder: 3},
  };
}

/** 'vscode' の require をスタブへ差し替える。多重呼び出しは無害。 */
function install(overrides = {}) {
  const stub = {...defaultStub(), ...overrides};
  if (!origLoad) {
    origLoad = Module._load;
    Module._load = function (request, ...args) {
      if (request === 'vscode') return stub;
      return origLoad.call(this, request, ...args);
    };
  }
  return stub;
}

/** 元の require へ戻す（テスト間で差し替えを残したくない場合に使う）。 */
function uninstall() {
  if (origLoad) {
    Module._load = origLoad;
    origLoad = null;
  }
}

module.exports = {install, uninstall};
