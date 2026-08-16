// MjpegParser（multipart/x-mixed-replace のインクリメンタル解析）の単体テスト。
// ネットワークには触らず、バイト列を直接流し込んで検証する。
const assert = require('node:assert');
const {
  MjpegParser,
  MjpegParseError,
  parseBoundary,
} = require('../out/capture/MjpegParser');

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const BOUNDARY = '--BoundaryString';

/** 1 パート分のバイト列を組み立てる。 */
function part(body, contentType = 'image/jpeg') {
  const header = Buffer.from(
    `${BOUNDARY}\r\nContent-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n\r\n`,
    'latin1'
  );
  return Buffer.concat([header, Buffer.from(body), Buffer.from('\r\n', 'latin1')]);
}

/** JPEG らしいバイト列（UTF-8 として不正な並びを必ず含む）。 */
function jpegLike(size, seed = 0) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) % 256;
  // SOI/EOI と、UTF-8 では復号できない 0xFF 0xFE 0xFF の並びを埋め込む
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xfe;
  b[4] = 0xff;
  b[size - 2] = 0xff;
  b[size - 1] = 0xd9;
  return b;
}

console.log('\n1) parseBoundary');
{
  check(
    'Content-Type から boundary を取る',
    parseBoundary('multipart/x-mixed-replace; boundary=BoundaryString') ===
      '--BoundaryString'
  );
  check(
    '引用符付きも剥がす',
    parseBoundary('multipart/x-mixed-replace; boundary="my-bound"') ===
      '--my-bound'
  );
  check(
    '既に -- で始まる値は二重付与しない',
    parseBoundary('multipart/x-mixed-replace; boundary=--abc') === '--abc'
  );
  check('boundary が無ければ null', parseBoundary('image/jpeg') === null);
  check('null 入力は null', parseBoundary(null) === null);
}

console.log('\n2) 基本のフレーム抽出');
{
  const p = new MjpegParser(BOUNDARY);
  const body = jpegLike(2048);
  const parts = p.push(part(body));
  check('1 フレーム取れる', parts.length === 1, `got ${parts.length}`);
  check('Content-Type が取れる', parts[0]?.contentType === 'image/jpeg');
  check(
    'バイト列が完全に一致する',
    parts[0] && Buffer.from(parts[0].data).equals(body)
  );
}

console.log('\n3) バイナリを文字列化しない（旧実装の回帰）');
{
  // 旧実装は buffer 全体を TextDecoder で文字列化し、その文字位置をバイト位置として
  // 使っていた。0xFF 等の不正シーケンスは U+FFFD 1 文字へ潰れるため位置がずれる。
  const p = new MjpegParser(BOUNDARY);
  const bodies = [jpegLike(1500, 1), jpegLike(1500, 2), jpegLike(1500, 3)];
  const stream = Buffer.concat(bodies.map((b) => part(b)));
  const parts = p.push(stream);
  check('連続 3 フレームが全て取れる', parts.length === 3, `got ${parts.length}`);
  check(
    '3 フレームとも中身がずれない',
    parts.length === 3 &&
      parts.every((x, i) => Buffer.from(x.data).equals(bodies[i]))
  );
}

console.log('\n4) チャンク境界がどこで割れても復元できる');
{
  const bodies = [jpegLike(700, 7), jpegLike(900, 9)];
  const stream = Buffer.concat(bodies.map((b) => part(b)));
  // 1 バイト刻み・素数刻み・ヘッダ途中で割れる位置を含めて総当りに近い形で試す
  const sizes = [1, 2, 3, 5, 13, 64, 255, 511, 1000, stream.length];
  let ok = true;
  let detail = '';
  for (const size of sizes) {
    const p = new MjpegParser(BOUNDARY);
    const got = [];
    for (let i = 0; i < stream.length; i += size) {
      for (const x of p.push(stream.subarray(i, i + size))) got.push(x);
    }
    if (
      got.length !== 2 ||
      !got.every((x, i) => Buffer.from(x.data).equals(bodies[i]))
    ) {
      ok = false;
      detail = `chunk=${size} got=${got.length}`;
      break;
    }
  }
  check('あらゆる分割で 2 フレームを復元する', ok, detail);
}

console.log('\n5) 非 JPEG パート（JSON-RPC 通知など）');
{
  const p = new MjpegParser(BOUNDARY);
  const parts = p.push(part(Buffer.from('{"event":"ping"}'), 'application/json'));
  check('Content-Type がそのまま返る', parts[0]?.contentType === 'application/json');
  check(
    '本体が読める',
    parts[0] && Buffer.from(parts[0].data).toString() === '{"event":"ping"}'
  );
}

console.log('\n6) Content-Length をパート毎にリセットする');
{
  // 2 つ目のパートに Content-Length が無い場合、旧実装は 1 つ目の値を使い回して
  // 無関係なバイト列をフレームとして流していた。今は壊れた入力として弾く。
  const p = new MjpegParser(BOUNDARY);
  p.push(part(jpegLike(512)));
  const broken = Buffer.from(
    `${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\nXXXX`,
    'latin1'
  );
  let threw = false;
  try {
    p.push(broken);
  } catch (e) {
    threw = e instanceof MjpegParseError;
  }
  check('Content-Length 欠落は MjpegParseError', threw);
}

console.log('\n7) 上限とリセット');
{
  const p = new MjpegParser(BOUNDARY, {maxPartSize: 1024});
  let threw = false;
  try {
    p.push(part(jpegLike(4096)));
  } catch (e) {
    threw = e instanceof MjpegParseError;
  }
  check('maxPartSize 超過は MjpegParseError', threw);

  const small = new MjpegParser(BOUNDARY, {maxBufferSize: 256});
  let threwBuf = false;
  try {
    // 1 チャンクで上限を超える量が届いた場合（ゴミを溜め込む経路は §8 で塞いでいる）
    small.push(Buffer.alloc(300, 0x41));
  } catch (e) {
    threwBuf = e instanceof MjpegParseError;
  }
  check('1 チャンクでの maxBufferSize 超過は MjpegParseError', threwBuf);

  const p2 = new MjpegParser(BOUNDARY);
  p2.push(Buffer.from(`${BOUNDARY}\r\nContent-Type: image/jpeg\r\n`, 'latin1'));
  check('途中データを保持している', p2.bufferedBytes > 0);
  p2.reset();
  check('reset で保持バイトが 0 になる', p2.bufferedBytes === 0);
  const after = p2.push(part(jpegLike(64)));
  check('reset 後も解析を続けられる', after.length === 1);
}

console.log('\n8) バウンダリ待ちでバッファが伸び続けない');
{
  // バウンダリが来ないゴミを流し続けても、保持は boundary 長 - 1 に収まる
  const p = new MjpegParser(BOUNDARY);
  for (let i = 0; i < 50; i++) p.push(Buffer.alloc(4096, 0x41));
  check(
    `保持バイトが ${BOUNDARY.length} 未満（実測 ${p.bufferedBytes}）`,
    p.bufferedBytes < BOUNDARY.length
  );
}

console.log('\n9) 大きなストリームでも線形時間で処理できる');
{
  // 旧実装はチャンク毎に全バッファを再確保 + 文字列化していたため O(n²) だった。
  const p = new MjpegParser(BOUNDARY);
  const body = jpegLike(100 * 1024); // 実測フレームサイズ相当（107KB）
  const frames = 60;
  const stream = Buffer.concat(Array.from({length: frames}, () => part(body)));
  const started = Date.now();
  let count = 0;
  for (let i = 0; i < stream.length; i += 16 * 1024) {
    count += p.push(stream.subarray(i, i + 16 * 1024)).length;
  }
  const elapsed = Date.now() - started;
  check(`${frames} フレーム取れる`, count === frames, `got ${count}`);
  check(`6MB を 1 秒以内に処理する（実測 ${elapsed}ms）`, elapsed < 1000);
}

console.log('\n10) 再接続のバックオフ');
{
  require('./helpers/vscode-stub').install();
  const {MjpegCapture} = require('../out/capture/MjpegCapture');
  const delays = [0, 1, 2, 3, 4, 5, 20].map((n) => MjpegCapture.reconnectDelayFor(n));
  check('初回は 500ms', delays[0] === 500, String(delays[0]));
  check('倍々で伸びる', delays[1] === 1000 && delays[2] === 2000 && delays[3] === 4000,
    JSON.stringify(delays));
  check('10 秒で頭打ち', delays[5] === 10000 && delays[6] === 10000, JSON.stringify(delays));
  check('単調非減少', delays.every((d, i) => i === 0 || d >= delays[i - 1]),
    JSON.stringify(delays));
}

assert.strictEqual(failures, 0, `${failures} 件のテストが失敗`);
console.log('\n全て成功');
