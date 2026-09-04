// 拡張の終了（ウィンドウを閉じる・拡張を無効化する）で、**録画中のファイルを
// 書き終えてから**畳むことを検証する。実デバイスも webview も要らない。
//
// ビュー録画（既定の経路）の生産者は webview 側の MediaRecorder にいる。
// コンテナを閉じる最後のチャンク（mp4 の `moov`）は `MediaRecorder.stop()` の
// あとに 1 つだけ届くので、**webview へ「止めろ」を送れないと永久に生まれない**。
//
// 以前の `dispose()` は先に `this.view = undefined` とリスナー解除をやってから
// 録画を止めていた。`requestViewStop()` は view が無いと即座に返るので、
// 「止めろ」は送られず、届いても受け取れなかった —— 映像は入っているのに
// 再生できないファイルが残り、`verifyRecording` の検査もこの経路では走らなかった。
// ここが素通りすると、その順序に戻せてしまう。
require('./helpers/vscode-stub').install({
  window: {
    createOutputChannel: () => ({
      appendLine() {},
      show() {},
      clear() {},
      dispose() {},
    }),
    // 終了中に出してはいけない（応答を待つと deactivate が返らない）。
    // 呼ばれたら分かるように記録する
    showErrorMessage: async (m) => {
      dialogs.push(String(m));
      return undefined;
    },
    showInformationMessage: async (m) => {
      dialogs.push(String(m));
      return undefined;
    },
    showWarningMessage: async (m) => {
      dialogs.push(String(m));
      return undefined;
    },
  },
});

const fs = require('fs');
const os = require('os');
const path = require('path');

const dialogs = [];

const {
  SimulatorWebviewProvider,
} = require('../out/webview/SimulatorWebviewProvider');
const {ViewRecordingWriter} = require('../out/simulator/ViewRecording');
const {verifyRecording} = require('../out/simulator/RecordingFile');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-shutdown-'));

/** `size`(4) + `type`(4) + 中身、の最上位 box を 1 つ組む（recording-file と同じ）。 */
function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

/** 録画中に届いているぶん（まだ再生できない）。 */
const head = () =>
  Buffer.concat([
    box('ftyp', Buffer.from('mp42isommp42', 'latin1')),
    box('mdat', Buffer.alloc(64, 0xaa)),
  ]);

/** 停止で最後に 1 つ届くチャンク。**これが無いと再生できない。** */
const tail = () => box('moov', Buffer.alloc(32, 0x11));

/**
 * 録画中の provider を組む。
 *
 * @param reply webview の振る舞い。'flush' は停止を受けて最後のチャンクを出す、
 *   'silent' は何も返さない（クラッシュしたレンダラ）。
 */
async function recordingProvider(fileName, reply) {
  const file = path.join(dir, fileName);
  const provider = new SimulatorWebviewProvider({fsPath: '/tmp/ext'});
  const sent = [];

  const writer = new ViewRecordingWriter(file, {
    maxBytes: 1024 * 1024,
    stallMs: 60_000,
    onAbort: (a) => sent.push({type: '__abort', abort: a}),
  });
  await writer.open();
  await writer.write(0, head());

  provider.view = {
    visible: true,
    webview: {
      postMessage: (m) => {
        sent.push(m);
        if (m.type !== 'stopViewRecording' || reply !== 'flush') return;
        // 実際の webview と同じく非同期で返す（最後のチャンク → 停止の応答）
        setTimeout(async () => {
          await provider.handleMessage({
            type: 'viewRecordingChunk',
            seq: 1,
            data: tail().toString('base64'),
          });
          await provider.handleMessage({type: 'viewRecordingStopped'});
        }, 0);
      },
    },
  };
  provider.viewWriter = writer;
  provider.viewRecordingMime = 'video/mp4';
  provider.recording = {
    deviceId: 'SIM-1',
    target: {fsPath: file},
    source: 'view',
  };
  return {provider, sent, file, writer};
}

async function main() {
  console.log('1) 録画中に終了したら、webview に止めさせて最後まで書く');
  {
    const {provider, sent, file} = await recordingProvider('flush.mp4', 'flush');
    const before = await verifyRecording(file);
    check(
      '前提: 停止前のファイルはまだ再生できない',
      before.ok === false && before.reason === 'no-moov',
      JSON.stringify(before)
    );

    await provider.dispose();

    check(
      'webview へ「録画を止めろ」を送る（view を落とす前に）',
      sent.some((m) => m.type === 'stopViewRecording'),
      JSON.stringify(sent.map((m) => m.type))
    );
    const after = await verifyRecording(file);
    check(
      '最後のチャンクまで書けている（再生できる形になる）',
      after.ok === true,
      JSON.stringify(after)
    );
    check(
      'moov が実際にファイルへ入っている',
      fs.readFileSync(file).includes('moov'),
      String(fs.statSync(file).size)
    );
    check('書き込み先を残さない', provider.viewWriter === null);
    check('録画セッションを畳む', provider.recording === null);
    check('ビューの参照を残さない', provider.view === undefined);
    check(
      '終了中はダイアログを出さない（応答を待つと deactivate が返らない）',
      dialogs.length === 0,
      JSON.stringify(dialogs)
    );
  }

  console.log('\n2) webview が返事をしなくても、待ち切って後始末を続ける');
  {
    // 本番の 5 秒をテストで待たない。上限そのものの働きだけを見る
    const original = SimulatorWebviewProvider.DISPOSE_STOP_BUDGET_MS;
    SimulatorWebviewProvider.DISPOSE_STOP_BUDGET_MS = 150;
    try {
      const {provider, sent} = await recordingProvider('silent.mp4', 'silent');
      const startedAt = Date.now();
      await provider.dispose();
      const elapsed = Date.now() - startedAt;
      check(
        '止めろは送っている',
        sent.some((m) => m.type === 'stopViewRecording'),
        JSON.stringify(sent.map((m) => m.type))
      );
      check(
        '上限で諦めて返る（無限には待たない）',
        elapsed < 3_000,
        `${elapsed}ms`
      );
      check('書き込み先を閉じる', provider.viewWriter === null);
      check(
        'ダイアログは出さない',
        dialogs.length === 0,
        JSON.stringify(dialogs)
      );
    } finally {
      SimulatorWebviewProvider.DISPOSE_STOP_BUDGET_MS = original;
    }
  }

  console.log('\n3) 録画していなければ何も待たない');
  {
    const provider = new SimulatorWebviewProvider({fsPath: '/tmp/ext'});
    const sent = [];
    provider.view = {visible: true, webview: {postMessage: (m) => sent.push(m)}};
    const startedAt = Date.now();
    await provider.dispose();
    check('すぐ返る', Date.now() - startedAt < 1_000);
    check(
      '録画停止の合図は送らない',
      !sent.some((m) => m.type === 'stopViewRecording'),
      JSON.stringify(sent.map((m) => m.type))
    );
  }

  console.log('\n4) 二重の dispose で壊れない（deactivate と subscriptions）');
  {
    const {provider} = await recordingProvider('twice.mp4', 'flush');
    await provider.dispose();
    await provider.dispose();
    check('2 回目も例外を投げない', true);
    check('書き込み先は閉じたまま', provider.viewWriter === null);
  }
}

main()
  .then(() => {
    fs.rmSync(dir, {recursive: true, force: true});
    console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
