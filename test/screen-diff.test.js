// screen-diff（BMP の変化ピクセル割合）の単体テスト。
// 実デバイスは要らない。合成した BMP を直接流し込んで検証する。
const assert = require('node:assert');
const {decodeBmp, diffRatio} = require('./helpers/screen-diff');

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/**
 * 32bpp BMP を組み立てる。simctl が出すのと同じ「高さが負＝トップダウン」。
 * fill(i) は i 番目のピクセルの [B, G, R] を返す。
 */
function makeBmp(width, height, fill, {topDown = true} = {}) {
  const OFFSET = 54;
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const [b, g, r] = fill(i);
    pixels[i * 4] = b;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = r;
    pixels[i * 4 + 3] = 0xff;
  }
  const head = Buffer.alloc(OFFSET);
  head.write('BM', 0, 'latin1');
  head.writeUInt32LE(OFFSET + pixels.length, 2);
  head.writeUInt32LE(OFFSET, 10);
  head.writeUInt32LE(40, 14); // DIB header size
  head.writeInt32LE(width, 18);
  head.writeInt32LE(topDown ? -height : height, 22);
  head.writeUInt16LE(1, 26); // planes
  head.writeUInt16LE(32, 28); // bpp
  return Buffer.concat([head, pixels]);
}

const W = 10;
const H = 10;
const black = () => [0, 0, 0];
const base = makeBmp(W, H, black);

console.log('decodeBmp');
{
  const info = decodeBmp(base);
  check('寸法とオフセットを読む', info.width === W && info.height === H && info.offset === 54);
  check('高さが負ならトップダウン', info.topDown === true);
  check(
    '高さが正ならボトムアップ',
    decodeBmp(makeBmp(W, H, black, {topDown: false})).topDown === false
  );
  assert.throws(() => decodeBmp(Buffer.alloc(100)), /BMP ではない/);
  check('BMP でないバイト列は例外', true);
  const bad = makeBmp(W, H, black);
  bad.writeUInt16LE(24, 28);
  assert.throws(() => decodeBmp(bad), /32bpp 以外/);
  check('32bpp 以外は例外', true);
  // ヘッダが主張する寸法にピクセルが足りない（切り詰められた読み込み）
  assert.throws(() => decodeBmp(base.subarray(0, 100)), /ピクセルデータが足りない/);
  check('ピクセル不足は例外', true);

  // 寸法 0 / 負を通すと総ピクセル数が 0 以下になり、diffRatio が NaN を返す。
  // 呼び手は全て `> 閾値` で判定するので NaN は「変化なし」に化ける（偽の HID 死亡）
  for (const [w, h, why] of [[0, 10, '幅 0'], [10, 0, '高さ 0'], [-10, 10, '幅が負']]) {
    const broken = makeBmp(1, 1, black);
    broken.writeInt32LE(w, 18);
    broken.writeInt32LE(-h, 22);
    assert.throws(() => decodeBmp(broken), /寸法が不正/, why);
    check(`${why}は例外`, true);
  }
  const zero = makeBmp(1, 1, black);
  zero.writeInt32LE(0, 18);
  assert.throws(() => diffRatio(zero, zero), /寸法が不正/);
  check('寸法 0 の diffRatio は NaN を返さず例外', true);
}

console.log('\ndiffRatio');
{
  check('同一画像は 0', diffRatio(base, base) === 0);

  // 100 ピクセル中 25 枚だけ真っ白にする
  const quarter = makeBmp(W, H, (i) => (i < 25 ? [255, 255, 255] : [0, 0, 0]));
  check('4 分の 1 の変化は 0.25', diffRatio(base, quarter) === 0.25, String(diffRatio(base, quarter)));

  check('全面の変化は 1', diffRatio(base, makeBmp(W, H, () => [255, 255, 255])) === 1);

  // tolerance 以下のゆらぎは変化と見なさない（実機の描画差を拾わないため）
  const noisy = makeBmp(W, H, () => [10, 10, 10]);
  check('許容内のゆらぎは 0', diffRatio(base, noisy, 12) === 0);
  check('許容を下げれば拾う', diffRatio(base, noisy, 5) === 1);

  // チャネルが 1 つだけ動いた場合も拾う（max ではなく or で見ている）
  check('青だけの変化も拾う', diffRatio(base, makeBmp(W, H, () => [255, 0, 0])) === 1);

  assert.throws(() => diffRatio(base, makeBmp(W, H + 1, black)), /寸法が違う/);
  check('寸法違いは例外', true);
  assert.throws(
    () => diffRatio(base, makeBmp(W, H, black, {topDown: false})),
    /寸法が違う/
  );
  check('向き違いは例外', true);
}

assert.strictEqual(failures, 0, `${failures} 件のテストが失敗`);
console.log('\n全て成功');
