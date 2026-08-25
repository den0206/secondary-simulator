// 録画ファイルの検査を検証する（実デバイス不要）。
//
// 実際に壊れて届いた mp4 と同じバイト列を組んで、moov の欠落を落とせるかを見る。
// ここが素通りすると、拡張は再生できないファイルを「保存しました」と言ってしまう。
const fs = require('fs');
const os = require('os');
const path = require('path');

const {verifyRecording} = require('../out/simulator/RecordingFile');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

/** `size`(4) + `type`(4) + 中身、の最上位 box を 1 つ組む。 */
function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

/** `ftyp`。中身は判定に使わないので長さだけ合わせる。 */
const ftyp = () => box('ftyp', Buffer.from('mp42isommp42', 'latin1'));

/**
 * 録画中の Android `MPEG4Writer` が書く途中状態そのもの。
 * `mdat` は 64bit サイズ指定（size=1）で、実サイズの代わりに "????????" が残る。
 */
function unfinalizedMdat(dataLength) {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0);
  head.write('mdat', 4, 'latin1');
  head.write('????????', 8, 'latin1');
  return Buffer.concat([head, Buffer.alloc(dataLength, 0xaa)]);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-file-'));
  const write = (name, buf) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, buf);
    return p;
  };

  console.log('壊れた録画を落とす');

  // 届いた 3 本と同じ構造: ftyp + 未使用の free(moov 用の予約) + finalize されていない mdat
  const brokenPath = write(
    'broken.mp4',
    Buffer.concat([
      ftyp(),
      box('free', Buffer.alloc(3192, 0x30)),
      unfinalizedMdat(4096),
    ])
  );
  const broken = await verifyRecording(brokenPath);
  check(
    '実際に壊れていた形（moov 無し・mdat が "????????"）を落とす',
    broken.ok === false && broken.reason === 'unfinalized',
    JSON.stringify(broken)
  );

  const emptyPath = write('empty.mp4', Buffer.alloc(0));
  const empty = await verifyRecording(emptyPath);
  check(
    '0 バイトを落とす',
    empty.ok === false && empty.reason === 'empty',
    JSON.stringify(empty)
  );

  const missing = await verifyRecording(path.join(tmp, 'nope.mp4'));
  check(
    '存在しないファイルでも例外を投げずに落とす',
    missing.ok === false && missing.reason === 'unreadable',
    JSON.stringify(missing)
  );

  // box は辿れるが moov がどこにも無い（finalize 前に mdat を閉じた形）
  const noMoovPath = write(
    'no-moov.mp4',
    Buffer.concat([ftyp(), box('mdat', Buffer.alloc(64, 0xaa))])
  );
  const noMoov = await verifyRecording(noMoovPath);
  check(
    'サイズは正しいが moov が無いものを落とす',
    noMoov.ok === false && noMoov.reason === 'no-moov',
    JSON.stringify(noMoov)
  );

  // 「末尾まで伸びる」mdat（size=0）。この後ろに moov は置けない
  const openMdat = Buffer.alloc(8);
  openMdat.writeUInt32BE(0, 0);
  openMdat.write('mdat', 4, 'latin1');
  const openPath = write(
    'open-mdat.mp4',
    Buffer.concat([ftyp(), openMdat, Buffer.alloc(64, 0xaa)])
  );
  const open = await verifyRecording(openPath);
  check(
    'size=0 の mdat で打ち切る',
    open.ok === false && open.reason === 'no-moov',
    JSON.stringify(open)
  );

  console.log('\n完成した録画は通す');

  // moov が末尾（Android / simctl の既定）
  const tailPath = write(
    'moov-tail.mp4',
    Buffer.concat([
      ftyp(),
      box('mdat', Buffer.alloc(4096, 0xaa)),
      box('moov', Buffer.alloc(512, 0x11)),
    ])
  );
  check('moov が末尾にあるものを通す', (await verifyRecording(tailPath)).ok === true);

  // moov が先頭（faststart）
  const frontPath = write(
    'moov-front.mp4',
    Buffer.concat([
      ftyp(),
      box('moov', Buffer.alloc(512, 0x11)),
      box('mdat', Buffer.alloc(4096, 0xaa)),
    ])
  );
  check('moov が先頭にあるものを通す', (await verifyRecording(frontPath)).ok === true);

  // 64bit サイズが正しく入っている mdat は飛び越えて moov に届く
  const largeHead = Buffer.alloc(16);
  largeHead.writeUInt32BE(1, 0);
  largeHead.write('mdat', 4, 'latin1');
  largeHead.writeBigUInt64BE(BigInt(16 + 2048), 8);
  const largePath = write(
    'moov-large-mdat.mp4',
    Buffer.concat([
      ftyp(),
      largeHead,
      Buffer.alloc(2048, 0xaa),
      box('moov', Buffer.alloc(256, 0x11)),
    ])
  );
  check(
    '64bit サイズの mdat を飛び越えて moov へ届く',
    (await verifyRecording(largePath)).ok === true
  );

  console.log('\nビュー録画（webm）は Cluster の有無で見る');

  // MediaRecorder の webm は EBML ヘッダ → Segment → Tracks → Cluster… と並ぶ。
  // 長さも Cues も入らない（＝mp4 の moov に当たるものが無い）ので、
  // 「絵が 1 つも入っていない」だけを落とす。
  const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const cluster = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

  const webmPath = write(
    'view.webm',
    Buffer.concat([ebml, Buffer.alloc(256, 0x42), cluster, Buffer.alloc(4096, 0x11)])
  );
  check('Cluster を含む webm を通す', (await verifyRecording(webmPath)).ok === true);

  // 頭だけ書けて止まった（＝1 フレームも符号化されていない）形
  const headOnlyPath = write(
    'head-only.webm',
    Buffer.concat([ebml, Buffer.alloc(256, 0x42)])
  );
  const headOnly = await verifyRecording(headOnlyPath);
  check(
    '映像の入っていない webm を落とす',
    headOnly.ok === false && headOnly.reason === 'no-cluster',
    JSON.stringify(headOnly)
  );

  // 64KB の読み境界をまたぐ Cluster を取りこぼさない（重ねて読んでいるか）
  const straddlePath = write(
    'straddle.webm',
    Buffer.concat([
      ebml,
      Buffer.alloc(64 * 1024 - 4 - 2, 0x42), // Cluster ID が境界の直前から始まる
      cluster,
      Buffer.alloc(1024, 0x11),
    ])
  );
  check(
    '読み境界をまたぐ Cluster も見つける',
    (await verifyRecording(straddlePath)).ok === true
  );

  fs.rmSync(tmp, {recursive: true, force: true});

  if (failures > 0) {
    console.log(`\n${failures} 件失敗`);
    process.exit(1);
  }
  console.log('\n全て成功');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
