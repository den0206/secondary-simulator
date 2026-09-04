// webview から届いたメッセージの境界検証を検証する。
//
// webview は自分たちの JS だが、`postMessage` の中身は構造化クローンなので型の
// 保証が無い。以前は `message.deviceId as string` のように**確かめずに**受けており、
// 値はそのまま mobilecli の params や `Buffer.from(data, 'base64')` へ流れていた。
// webview だけが作り直される経路（レンダラのクラッシュ・リロード）や、拡張の版と
// webview の版がずれた状態は実際に起きるので、境界で落とす。
const configUpdates = [];
require('./helpers/vscode-stub').install({
  workspace: {
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
      update: async (key, value) => {
        configUpdates.push({key, value});
      },
    }),
    onDidChangeConfiguration: () => ({dispose() {}}),
  },
});

const {
  SimulatorWebviewProvider,
} = require('../out/webview/SimulatorWebviewProvider');
const {
  asFiniteNumber,
  asFlag,
  asIndex,
  asPositiveNumber,
  asText,
  asTextArray,
} = require('../out/webview/WebviewMessage');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

/** 「無い」の代表。どの関数もこれらを通してはいけない。 */
const MISSING = [undefined, null, {}, [], () => {}];

console.log('1) 文字列（デバイス ID・キー・base64 のチャンク）');
check('文字列は通る', asText('SIM-1') === 'SIM-1');
check('空文字は落とす（ID として意味を持たない）', asText('') === null);
check('数値は落とす（ID に化けさせない）', asText(123) === null);
for (const v of MISSING) {
  check(`${JSON.stringify(v) ?? typeof v} を落とす`, asText(v) === null);
}

console.log('\n2) 有限の数値（座標）');
check('小数は通る', asFiniteNumber(0.5) === 0.5);
check('0 も通る（左上の端）', asFiniteNumber(0) === 0);
check('負も通る（clamp は呼び手の責務）', asFiniteNumber(-1) === -1);
check('NaN は落とす', asFiniteNumber(NaN) === null);
check('Infinity は落とす', asFiniteNumber(Infinity) === null);
check(
  '数字の文字列は落とす（暗黙の変換をしない）',
  asFiniteNumber('0.5') === null
);

console.log('\n3) 連番（録画チャンクの seq）');
check('0 から始まる整数は通る', asIndex(0) === 0 && asIndex(7) === 7);
check('負は落とす', asIndex(-1) === null);
check('小数は落とす（連番にならない）', asIndex(1.5) === null);
check('NaN は落とす', asIndex(NaN) === null);

console.log('\n4) 正の数（表示幅）');
check('正は通る', asPositiveNumber(320) === 320);
check('0 は落とす（幅 0 で取り込みを張り直させない）', asPositiveNumber(0) === null);
check('負は落とす', asPositiveNumber(-320) === null);

console.log('\n5) 真偽値（自動接続のスイッチ）');
check('true / false は通る', asFlag(true) === true && asFlag(false) === false);
check(
  '文字列の "true" は落とす（設定へ書き戻す値なので厳しく見る）',
  asFlag('true') === null
);
check('1 は落とす', asFlag(1) === null);
check('undefined は落とす', asFlag(undefined) === null);

console.log('\n6) 文字列の配列（修飾キー）');
check(
  '全て文字列なら通る',
  JSON.stringify(asTextArray(['Meta', 'Shift'])) === '["Meta","Shift"]'
);
check('空配列も通る（修飾キー無し）', JSON.stringify(asTextArray([])) === '[]');
check(
  '1 つでも文字列でなければ落とす（部分的に受けると意味が変わる）',
  asTextArray(['Meta', 3]) === null
);
check('配列でなければ落とす', asTextArray('Meta') === null);

// 関数が正しいだけでは足りない。**handleMessage が実際にそれを通しているか**を見る
// （以前はここが `as string` で、確かめずに下流へ渡していた）。
async function wiring() {
  console.log('\n7) handleMessage が形の合わないメッセージを下流へ流さない');
  const provider = new SimulatorWebviewProvider({fsPath: '/tmp/ext'});
  const sent = [];
  provider.view = {visible: true, webview: {postMessage: (m) => sent.push(m)}};

  const calls = [];
  provider.selectDevice = async (id) => calls.push(['selectDevice', id]);
  provider.confirmAndBoot = async (id) => calls.push(['confirmAndBoot', id]);
  provider.currentDeviceId = 'SIM-1';
  provider.inputController = {
    keypress: async (...args) => calls.push(['keypress', ...args]),
    dispose() {},
  };

  await provider.handleMessage({type: 'deviceChange', deviceId: 123});
  await provider.handleMessage({type: 'deviceChange', deviceId: ''});
  await provider.handleMessage({type: 'bootDevice'});
  check(
    'デバイス ID が文字列でなければ繋ぎに行かない',
    calls.length === 0,
    JSON.stringify(calls)
  );

  await provider.handleMessage({type: 'deviceChange', deviceId: 'SIM-2'});
  check(
    '正しい ID はそのまま通る',
    JSON.stringify(calls) === '[["selectDevice","SIM-2"]]',
    JSON.stringify(calls)
  );

  calls.length = 0;
  await provider.handleMessage({type: 'keypress', key: 42});
  await provider.handleMessage({type: 'keypress'});
  check('キーが文字列でなければ送らない', calls.length === 0, JSON.stringify(calls));

  await provider.handleMessage({
    type: 'keypress',
    key: 'a',
    special: 'yes',
    modifiers: ['Meta', 7],
  });
  check(
    '修飾キーの一覧が壊れていても、キー自体は送る（修飾キー無しとして）',
    JSON.stringify(calls) === '[["keypress","a",false,null]]' ||
      JSON.stringify(calls) === '[["keypress","a",false]]',
    JSON.stringify(calls)
  );

  await provider.handleMessage({type: 'setAutoConnect', enabled: 'true'});
  check(
    '真偽値でなければ設定へ書き戻さない',
    configUpdates.length === 0,
    JSON.stringify(configUpdates)
  );
  await provider.handleMessage({type: 'setAutoConnect', enabled: false});
  check(
    '真偽値ならそのまま書き戻す',
    configUpdates.length === 1 && configUpdates[0].value === false,
    JSON.stringify(configUpdates)
  );

  // 連番・base64 が壊れたチャンクは書かない。**捨てても消えはしない** —
  // 連番が飛ぶので ViewRecordingWriter が gap として録画ごと打ち切る
  const written = [];
  provider.viewWriter = {
    write: async (seq) => {
      written.push(seq);
      return true;
    },
    close: async () => {},
  };
  await provider.handleMessage({type: 'viewRecordingChunk', seq: -1, data: 'AA'});
  await provider.handleMessage({type: 'viewRecordingChunk', seq: 1.5, data: 'AA'});
  await provider.handleMessage({type: 'viewRecordingChunk', seq: 0, data: 0});
  check('形の合わないチャンクは書かない', written.length === 0, JSON.stringify(written));
  await provider.handleMessage({type: 'viewRecordingChunk', seq: 0, data: 'AA'});
  check('正しいチャンクは書く', JSON.stringify(written) === '[0]', JSON.stringify(written));
  check(
    '書けたら ack を返す',
    sent.some((m) => m.type === 'viewRecordingAck' && m.seq === 0),
    JSON.stringify(sent.map((m) => m.type))
  );
  provider.viewWriter = null;

  // 幅 0 で取り込みを張り直させない（例外も投げない）
  await provider.handleMessage({type: 'viewport', width: 0});
  await provider.handleMessage({type: 'viewport'});
  check('壊れた viewport で落ちない', true);

  await provider.dispose();
}

wiring()
  .then(() => {
    console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
