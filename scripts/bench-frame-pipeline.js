#!/usr/bin/env node
// サイドカー → webview のフレーム経路のうち、拡張ホスト側の処理コストを再現して測る。
// 拡張ホスト側の処理コストを再現して測る。
//
//   node scripts/bench-frame-pipeline.js
//
// 注意: 画像デコード（createImageBitmap）と実際の JPEG エンコードは含まない。
// ここで見たいのは「絵を 1 ピクセルも描かずに使っている時間」だけ。
// test/*.test.js に一致しないので `npm test` では走らない（手動実行）。

const N = 300;
// 68KB は docs/sidecar-protocol.md §3.5 の実測値（iPhone 17 / 640px / q60）。
// 120KB は maxWidth を広げた場合の目安。
const SIZES = [68 * 1024, 120 * 1024];

function makeJpeg(bytes) {
  const b = Buffer.alloc(bytes);
  // 圧縮も base64 も内容で速度が変わらないよう、偏りのない擬似データにする
  for (let i = 0; i < bytes; i++) b[i] = (i * 2654435761) & 0xff;
  b[0] = 0xff;
  b[1] = 0xd8;
  return b;
}

// JIT の暖まり具合で 2 倍以上ぶれるので、捨て実行を 1 回入れてから 3 回測り中央値を取る。
function bench(label, fn) {
  fn();
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6 / N);
  }
  samples.sort((a, b) => a - b);
  return {label, ms: samples[1]};
}

for (const size of SIZES) {
  const jpeg = makeJpeg(size);
  const b64 = jpeg.toString('base64');
  const line =
    JSON.stringify({event: 'frame', device: 'UDID', w: 640, h: 1388, data: b64}) + '\n';
  const lineBuf = Buffer.from(line, 'utf8');

  const rows = [
    // SimhidSidecar.onStdout: 64KB のチャンクで届く前提の文字列連結 + 行分割
    bench('stdout 連結 + 行分割', () => {
      for (let i = 0; i < N; i++) {
        let buf = '';
        for (let off = 0; off < lineBuf.length; off += 65536) {
          buf += lineBuf.subarray(off, Math.min(off + 65536, lineBuf.length)).toString('utf8');
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            buf.slice(0, nl);
            buf = buf.slice(nl + 1);
          }
        }
      }
    }),
    bench('JSON.parse', () => {
      for (let i = 0; i < N; i++) JSON.parse(line);
    }),
    // SidecarCapture.onFrame: base64 → Buffer
    bench('base64 → Buffer（デコード）', () => {
      for (let i = 0; i < N; i++) Buffer.from(b64, 'base64');
    }),
    // SimulatorWebviewProvider: その Buffer をまた base64 へ戻している
    bench('Buffer → base64（再エンコード）', () => {
      for (let i = 0; i < N; i++) jpeg.toString('base64');
    }),
    // media/webview/main.js: base64ToBytes の 1 バイトずつのループ
    bench('webview atob + 詰め替え', () => {
      for (let i = 0; i < N; i++) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      }
    }),
  ];

  const total = rows.reduce((a, r) => a + r.ms, 0);
  console.log(`\n=== JPEG ${(size / 1024).toFixed(0)}KB / base64 ${(b64.length / 1024).toFixed(0)}KB ===`);
  for (const r of rows) console.log(`  ${r.label.padEnd(30)} ${r.ms.toFixed(3)} ms/frame`);
  console.log(`  ${'合計'.padEnd(30)} ${total.toFixed(3)} ms/frame  （30fps で 1 コアの ${(total * 30 / 10).toFixed(1)}%）`);
}
