// webview が作り直されたときに、ホストが「もう送った」で黙らないことを検証する。
//
// デバイス一覧は 5 秒ごとのポーリングで毎回送ると <select> が作り直されるので、
// 署名が同じなら送らない。**この署名は「この webview へ送った」の記録**なので、
// webview だけが作り直されたとき（レンダラのクラッシュ・リロード・ビューの移動）に
// 捨てないと、一覧が空のまま何も選べなくなる（更新ボタンも同じ判定に当たる）。
//
// 実デバイスも webview も要らない。provider に偽のクライアントとビューを差すだけ。
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

// 停止中のデバイスだけを返す（自動接続が実キャプチャを始めないように）
const DEVICES = [
  {
    id: 'SIM-1',
    name: 'iPhone 17',
    platform: 'ios',
    state: 'offline',
    version: '26.0',
    type: 'simulator',
  },
];

async function main() {
  const provider = new SimulatorWebviewProvider({fsPath: '/tmp/ext'});
  const sent = [];
  provider.view = {
    visible: true,
    webview: {postMessage: (m) => sent.push(m)},
  };
  provider.mobileCliClient = {
    listDevices: async () => ({devices: DEVICES}),
  };
  const devicesMessages = () => sent.filter((m) => m.type === 'devices');

  console.log('1) 初回は一覧を送る');
  await provider.refreshDevices();
  check(
    '一覧を送る',
    devicesMessages().length === 1 && devicesMessages()[0].devices.length === 1,
    JSON.stringify(devicesMessages())
  );

  console.log('\n2) 中身が同じポーリングでは送らない（<select> を作り直さない）');
  sent.length = 0;
  await provider.refreshDevices();
  check('差分が無ければ送らない', devicesMessages().length === 0);

  console.log('\n3) webview が作り直されたら送り直す（init が唯一確実な合図）');
  sent.length = 0;
  await provider.handleMessage({type: 'init'});
  check(
    '一覧を送り直す',
    devicesMessages().length === 1 && devicesMessages()[0].devices.length === 1,
    JSON.stringify(sent.map((m) => m.type))
  );
  check(
    '入力経路のラベルも送り直す',
    sent.some((m) => m.type === 'mode'),
    JSON.stringify(sent.map((m) => m.type))
  );

  console.log('\n3b) 繋いだままの作り直しでは選択も戻す（<select> は新品）');
  provider.currentDeviceId = 'SIM-1';
  sent.length = 0;
  await provider.handleMessage({type: 'init'});
  const order = sent.map((m) => m.type);
  check(
    '選択中のデバイスを送り直す',
    sent.some((m) => m.type === 'selectedDevice' && m.deviceId === 'SIM-1'),
    JSON.stringify(order)
  );
  check(
    '一覧より後に送る（<option> が無いうちに選べない）',
    order.indexOf('devices') < order.indexOf('selectedDevice'),
    JSON.stringify(order)
  );
  provider.currentDeviceId = null;

  console.log('\n4) 更新ボタンは「差分なし」で黙らない');
  sent.length = 0;
  await provider.handleMessage({type: 'refresh'});
  check('押したら必ず送る', devicesMessages().length === 1);

  console.log('\n5) 録画中に作り直されたら Rec の表示も戻す');
  provider.recording = {
    deviceId: 'SIM-1',
    target: {fsPath: '/tmp/rec.mp4'},
    source: 'device',
  };
  sent.length = 0;
  await provider.handleMessage({type: 'init'});
  check(
    '録画中の表示を戻す',
    sent.some((m) => m.type === 'recording' && m.active === true),
    JSON.stringify(sent.map((m) => m.type))
  );
  provider.recording = null;

  provider.stopAutoConnectTimer();
  console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
