// 入力の中身がログにも UI にも出ないことを検証する。
//
// OutputChannel は VS Code が全文をメモリに持ち、古い行を捨てる API が無い。
// そこへ打鍵や貼り付けの内容を書くと、パスワードがセッション中残り続け、
// 不具合報告でログを貼れば外へ出る。RPC のエラー文も webview のオーバーレイへ
// そのまま表示されるので、同じ理由で params を載せない。
const path = require('path');

const lines = [];
// debug でも内容が出ないことを見る（logLevel を下げる人がいる）。
require('./helpers/vscode-stub').install({
  window: {
    createOutputChannel: () => ({
      appendLine(line) {
        lines.push(line);
      },
      show() {},
      clear() {
        lines.length = 0;
      },
      dispose() {},
    }),
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key === 'logLevel' ? 'debug' : fallback),
    }),
  },
  // 貼り付けの中身はここから読まれる。ログへ出ないことをこの秘密で見る。
  env: {clipboard: {readText: async () => 'hunter2', writeText: async () => {}}},
});

const ROOT = path.join(__dirname, '..');
const {Logger} = require(path.join(ROOT, 'out/utils/Logger'));
const {JsonRpcClient} = require(path.join(ROOT, 'out/utils/JsonRpcClient'));
const {
  SimulatorWebviewProvider,
} = require(path.join(ROOT, 'out/webview/SimulatorWebviewProvider'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

Logger.initialize();

// --- 打鍵 -------------------------------------------------------------
// 端末未選択でも handleMessage は最後まで通る（ここで見たいのはログだけ）。
const provider = new SimulatorWebviewProvider({fsPath: ROOT});

(async () => {
  // 打った文字（`Ω`）と貼り付けた内容（`hunter2`）はどこにも出てはいけない。
  await provider.handleMessage({type: 'keypress', key: 'Ω'});
  await provider.handleMessage({type: 'keypress', key: 'Enter', special: true});
  // 貼り付けの中身はホストが vscode.env.clipboard から読む（webview は載せない）。
  await provider.handleMessage({type: 'paste'});

  const log = lines.join('\n');
  check('打った文字がログに出ない', !log.includes('Ω'), log);
  check('貼り付けた内容がログに出ない', !log.includes('hunter2'), log);
  check('打鍵があったことは分かる', log.includes('keypress'), log);
  check('特殊キー名は残る（内容ではない）', log.includes('Enter'), log);

  // --- RPC のエラー文 -------------------------------------------------
  // params を丸ごと載せると、貼り付け内容が例外メッセージ経由で
  // ログと webview のオーバーレイの両方へ出る。
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      error: {code: -32000, message: 'wda not running'},
    }),
  });

  const client = new JsonRpcClient('http://localhost:12000');
  let message = '';
  try {
    await client.sendJsonRpcRequest('device.io.text', {
      deviceId: 'UDID-1',
      text: 'hunter2',
    });
  } catch (error) {
    message = error.message;
  } finally {
    globalThis.fetch = origFetch;
  }

  check('RPC エラーが投げられる', message.length > 0, message);
  check('エラー文に params が入らない', !message.includes('hunter2'), message);
  check('メソッド名は残る', message.includes('device.io.text'), message);
  check('deviceId は残る（診断に要る）', message.includes('UDID-1'), message);

  if (failures > 0) {
    console.log(`\n${failures} 件失敗`);
    process.exit(1);
  }
  console.log('\n全て成功');
})();
