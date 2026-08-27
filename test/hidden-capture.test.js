// 「非表示のあいだ取り込みを動かさない」「作り直された webview に映像を戻す」の 2 つを見る。
//
// この 2 つは裏表になっている。`retainContextWhenHidden` を付けていないので、
// 畳むと webview は捨てられ、開き直すと作り直される（VS Code 自身が推奨する形）。
// つまり:
//
//   - 畳んだ後に取り込みだけ生き返ってはいけない（隠れたまま流れ続ける）
//   - 開き直したら必ず映像を戻さなければならない（繋いだまま何も映らない画面が残る）
//
// 前者はビュー録画の停止が非同期であることから起きていた。停止の最後で
// 取り込みを張り直すが、その頃には畳む処理が既に取り込みを止めている。
require('./helpers/vscode-stub').install({
  window: {
    createOutputChannel: () => ({
      appendLine() {},
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

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

const DEVICE = {
  id: 'SIM-1',
  name: 'iPhone 17',
  platform: 'ios',
  state: 'online',
  version: '26.0',
  type: 'simulator',
};

/** 取り込みを実際に始めない provider。張り直しの回数だけ数える。 */
function makeProvider() {
  const provider = new SimulatorWebviewProvider({fsPath: '/tmp/ext'});
  const sent = [];
  const started = [];
  provider.view = {visible: true, webview: {postMessage: (m) => sent.push(m)}};
  provider.mobileCliClient = {listDevices: async () => ({devices: [DEVICE]})};
  provider.startCaptureForDevice = async (id) => {
    started.push(id);
  };
  return {provider, sent, started};
}

async function main() {
  console.log('1) 非表示なら録画後の張り直しをしない');
  {
    const {provider, started} = makeProvider();
    provider.currentDeviceId = DEVICE.id;
    provider.devices = [{...DEVICE, state: 'Booted'}];
    // 直結配信のために中継へ固定していた状態（ここでだけ張り直しが走る）
    provider.forceRelayCapture = true;
    provider.view.visible = false;
    await provider.releaseViewCapture();
    check('張り直さない', started.length === 0, JSON.stringify(started));
    check('固定は解除する（状態は戻す）', provider.forceRelayCapture === false);
    check('録画用の幅指定も戻す', provider.viewRecordingCapture === false);
  }

  console.log('\n2) 表示中なら張り直す（録画をやめたら直結へ戻る）');
  {
    const {provider, started} = makeProvider();
    provider.currentDeviceId = DEVICE.id;
    provider.devices = [{...DEVICE, state: 'Booted'}];
    provider.forceRelayCapture = true;
    provider.view.visible = true;
    await provider.releaseViewCapture();
    check('張り直す', started.length === 1, JSON.stringify(started));
  }

  console.log('\n3) 作り直された webview には映像を戻す');
  {
    const {provider, started} = makeProvider();
    provider.currentDeviceId = DEVICE.id;
    // 畳んだときに取り込みは止めてある（currentCapture は無い）
    provider.currentCapture = null;
    await provider.restoreWebviewState();
    check('張り直す', started.length === 1, JSON.stringify(started));
  }

  console.log('\n4) 既に流れているなら触らない（二重に張り直さない）');
  {
    const {provider, started} = makeProvider();
    provider.currentDeviceId = DEVICE.id;
    // 可視化イベントが先に張り直した後、という状況
    provider.currentCapture = {dispose() {}};
    provider.directStreaming = false;
    await provider.restoreWebviewState();
    check('張り直さない', started.length === 0, JSON.stringify(started));
  }

  console.log('\n5) 直結配信は URL を送り直すために必ず張り直す');
  {
    const {provider, started} = makeProvider();
    provider.currentDeviceId = DEVICE.id;
    provider.currentCapture = {dispose() {}};
    provider.directStreaming = true;
    await provider.restoreWebviewState();
    check('張り直す', started.length === 1, JSON.stringify(started));
  }

  console.log('\n6) 未接続なら何もしない（自動接続の対象が無いとき）');
  {
    const {provider, started} = makeProvider();
    // 停止中しか無ければ自動接続も動かない。ここで張り直すと繋いでいない端末を映す
    provider.mobileCliClient = {
      listDevices: async () => ({devices: [{...DEVICE, state: 'offline'}]}),
    };
    provider.currentDeviceId = null;
    await provider.restoreWebviewState();
    check('張り直さない', started.length === 0, JSON.stringify(started));
  }
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
