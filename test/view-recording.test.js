// ビュー録画の書き込み側を検証する（webview も端末も要らない）。
//
// ここで見るのは**上限の当たり方**。録画のチャンクは touchMove と違って捨てられない
// （1 つ落ちるとコンテナが壊れ、映像が入っているのに再生できないファイルが残る）ので、
// 詰まった・飛んだ・伸びすぎたときに「捨てる」ではなく「止める」になっているかを見る。
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  containerExtension,
  ViewRecordingWriter,
} = require('../out/simulator/ViewRecording');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-view-rec-'));
const target = (name) => path.join(dir, name);
const bytes = (n, fill = 0xab) => new Uint8Array(Buffer.alloc(n, fill));

async function main() {
  console.log('1) MIME から保存時の拡張子を決める');
  check(
    'mp4',
    containerExtension('video/mp4;codecs=avc1.42E01E') === 'mp4',
    String(containerExtension('video/mp4;codecs=avc1.42E01E'))
  );
  check('webm', containerExtension('video/webm;codecs=vp9') === 'webm');
  check(
    'matroska も webm 扱い',
    containerExtension('video/x-matroska;codecs=avc1') === 'webm'
  );
  check('未知の型は決めない', containerExtension('video/ogg') === null);
  check('未設定も決めない', containerExtension(undefined) === null);

  console.log('\n2) 連番どおりなら書けて、ack を返せる');
  {
    const file = target('ok.webm');
    const writer = new ViewRecordingWriter(file, {
      maxBytes: 1024,
      stallMs: 60_000,
      onAbort: () => check('打ち切られない', false),
    });
    await writer.open();
    const a = await writer.write(0, bytes(10, 1));
    const b = await writer.write(1, bytes(10, 2));
    await writer.close();
    check('書けたら true', a === true && b === true, `${a},${b}`);
    check('書いたバイト数を数える', writer.bytesWritten === 20, String(writer.bytesWritten));
    const written = fs.readFileSync(file);
    check(
      '順番どおりに並ぶ',
      written.length === 20 && written[0] === 1 && written[19] === 2,
      `len=${written.length}`
    );
  }

  console.log('\n3) 連番が飛んだら止める（欠けたまま書き続けない）');
  {
    const aborts = [];
    const writer = new ViewRecordingWriter(target('gap.webm'), {
      maxBytes: 1024,
      stallMs: 60_000,
      onAbort: (a) => aborts.push(a),
    });
    await writer.open();
    await writer.write(0, bytes(4));
    const skipped = await writer.write(2, bytes(4)); // 1 が来ていない
    check('飛んだチャンクは書かない（＝ack を返さない）', skipped === false);
    check('gap として打ち切る', aborts.length === 1 && aborts[0].reason === 'gap', JSON.stringify(aborts));
    check('欠番を報告する', aborts[0].expected === 1 && aborts[0].got === 2, JSON.stringify(aborts[0]));
    const after = await writer.write(1, bytes(4));
    check('打ち切った後は受け付けない', after === false);
    check('打ち切りは 1 回だけ通知する', aborts.length === 1, String(aborts.length));
    await writer.close();
  }

  console.log('\n4) 総量の上限で止める（ファイルの伸びを言い切れる）');
  {
    const aborts = [];
    const file = target('size.webm');
    const writer = new ViewRecordingWriter(file, {
      maxBytes: 16,
      stallMs: 60_000,
      onAbort: (a) => aborts.push(a),
    });
    await writer.open();
    await writer.write(0, bytes(10));
    const over = await writer.write(1, bytes(10)); // 20 > 16
    await writer.close();
    check('上限を超えるチャンクは書かない', over === false);
    check('size として打ち切る', aborts.length === 1 && aborts[0].reason === 'size', JSON.stringify(aborts));
    check(
      '上限を超えたファイルを作らない',
      fs.statSync(file).size === 10,
      String(fs.statSync(file).size)
    );
  }

  console.log('\n5) チャンクが途切れたら止める（webview が消えた合図）');
  {
    const aborts = [];
    const writer = new ViewRecordingWriter(target('stall.webm'), {
      maxBytes: 1024,
      stallMs: 30,
      onAbort: (a) => aborts.push(a),
    });
    await writer.open();
    // 開いただけでは見張らない。webview が符号化を始めるまでの待ちを
    // 「途切れた」と数えると、始まる前に打ち切ってしまう。
    await new Promise((resolve) => setTimeout(resolve, 80));
    check('録画が始まる前は打ち切らない', aborts.length === 0, JSON.stringify(aborts));
    writer.startWatch();
    await writer.write(0, bytes(4));
    await new Promise((resolve) => setTimeout(resolve, 80));
    check('stalled として打ち切る', aborts.length === 1 && aborts[0].reason === 'stalled', JSON.stringify(aborts));
    await writer.close();
    // 閉じた後にタイマーが残っていると、次の録画に割り込む
    await new Promise((resolve) => setTimeout(resolve, 60));
    check('閉じたら見張りも外す', aborts.length === 1, String(aborts.length));
  }

  console.log('\n6) 閉じるまでの書き込みを落とさない');
  {
    const file = target('flush.webm');
    const writer = new ViewRecordingWriter(file, {
      maxBytes: 1024 * 1024,
      stallMs: 60_000,
      onAbort: () => check('打ち切られない', false),
    });
    await writer.open();
    // ack を待たずに続けて投げても、順番どおりに書き切ってから閉じる
    const pending = [
      writer.write(0, bytes(1000, 1)),
      writer.write(1, bytes(1000, 2)),
      writer.write(2, bytes(1000, 3)),
    ];
    await writer.close();
    await Promise.all(pending);
    const written = fs.readFileSync(file);
    check('全部書けている', written.length === 3000, String(written.length));
    check(
      '並べ替わっていない',
      written[0] === 1 && written[1000] === 2 && written[2000] === 3
    );
  }

  fs.rmSync(dir, {recursive: true, force: true});
  console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
