// デバイス探索が失敗し続けたときに、拡張が黙るかを検証する。
//
// 未接続のあいだ provider は 5 秒ごとにデバイス一覧を取りに行く。mobilecli が
// 入っていない・起動できないマシンでは**毎回失敗する**ので、そのたびに
// `Logger.error`（メッセージ＋スタックで 2 行以上）と webview へのエラー送信が
// 積み上がっていた。OutputChannel は VS Code が全文をメモリに持ち、拡張から
// 古い行を捨てる API が無い（docs/project-review.md §3.5.7）ので、
// サイドバーを開いて放置するだけでメモリが伸びる。
//
// `MjpegCapture` の再接続には同じ理由でバックオフと記録の打ち切りが入っている。
// ここでは探索側にも同じ性質があることを見る。
const lines = [];
require('./helpers/vscode-stub').install({
  window: {
    createOutputChannel: () => ({
      appendLine: (line) => lines.push(line),
      show() {},
      clear() {},
      dispose() {},
    }),
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
  },
});

const {
  SimulatorWebviewProvider,
} = require('../out/webview/SimulatorWebviewProvider');
const {
  AUTO_CONNECT_BASE_MS,
  AUTO_CONNECT_MAX_MS,
} = require('../out/simulator/autoConnect');

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

const errorLines = () =>
  lines.filter((l) => l.includes('Failed to list devices via mobilecli'));

async function main() {
  const provider = new SimulatorWebviewProvider({fsPath: '/tmp/ext'});
  const sent = [];
  provider.view = {visible: true, webview: {postMessage: (m) => sent.push(m)}};
  let mode = 'fail';
  provider.mobileCliClient = {
    listDevices: async () => {
      if (mode === 'fail') throw new Error('connect ECONNREFUSED 127.0.0.1:12000');
      return {devices: []};
    },
  };

  console.log('1) 失敗が続いてもログは増え続けない');
  for (let i = 0; i < 8; i++) await provider.refreshDevices();
  check('8 回失敗した', provider.deviceListFailures === 8, String(provider.deviceListFailures));
  check(
    '記録は最初の 3 回まで',
    errorLines().length === 3,
    `${errorLines().length} 行`
  );

  console.log('\n2) 同じエラーを webview へ送り直さない');
  const errors = sent.filter((m) => m.type === 'error');
  check('1 通だけ', errors.length === 1, JSON.stringify(errors));
  check(
    '文言は理由を含む',
    errors[0] && errors[0].text.includes('Failed to list devices'),
    JSON.stringify(errors[0])
  );

  console.log('\n3) 探索の間隔が伸びている');
  check(
    `${AUTO_CONNECT_BASE_MS}ms より長い`,
    provider.autoConnectDelayMs > AUTO_CONNECT_BASE_MS,
    `${provider.autoConnectDelayMs}ms`
  );
  check(
    '上限で頭打ち',
    provider.autoConnectDelayMs === AUTO_CONNECT_MAX_MS,
    `${provider.autoConnectDelayMs}ms`
  );

  console.log('\n4) 1 回でも取れたら元に戻る');
  mode = 'ok';
  await provider.refreshDevices();
  check('失敗数が 0', provider.deviceListFailures === 0);
  check(
    '間隔が基本値へ戻る',
    provider.autoConnectDelayMs === AUTO_CONNECT_BASE_MS,
    `${provider.autoConnectDelayMs}ms`
  );

  console.log('\n5) 復帰したあとの失敗はまた出す（黙ったままにしない）');
  lines.length = 0;
  sent.length = 0;
  mode = 'fail';
  await provider.refreshDevices();
  check('記録する', errorLines().length === 1, `${errorLines().length} 行`);
  check(
    'webview にも出す',
    sent.filter((m) => m.type === 'error').length === 1,
    JSON.stringify(sent.filter((m) => m.type === 'error'))
  );

  console.log('\n6) 再試行を押したら同じ文言でも出し直す');
  sent.length = 0;
  await provider.handleMessage({type: 'retry'});
  check(
    '押した回数だけ反応する',
    sent.filter((m) => m.type === 'error').length === 1,
    JSON.stringify(sent.filter((m) => m.type === 'error'))
  );

  provider.dispose();
}

main()
  .then(() => {
    console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
