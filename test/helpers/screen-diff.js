/**
 * 画面が変化したかを「変化ピクセルの割合」で見るための最小実装。
 *
 * PNG ではなく BMP を読むのは、**node 標準だけでピクセルへ手が届く**のがこれだけ
 * だから（`xcrun simctl io <udid> screenshot --type=bmp`）。差分のためだけに
 * PNG デコーダを足さない。
 *
 * 判定は「タップが本当にデバイスへ届いたか」に使う。HID 注入が無言で失敗しても
 * ログは静かなので、画面が動いたかどうかを外から見るしかない。
 */

/** BMP(32bpp 無圧縮) のヘッダを読む。それ以外は扱わない（simctl が出すのは常にこれ）。 */
function decodeBmp(buf) {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
    throw new Error('BMP ではない');
  }
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 32) throw new Error(`32bpp 以外は扱わない: ${bpp}bpp`);
  const height = Math.abs(rawHeight);
  // 高さが負＝トップダウン。差分は同じ並び同士でしか取らないので向きは持つだけでよい
  const topDown = rawHeight < 0;
  // **0 や負を通すと総ピクセル数が 0 以下になり、diffRatio が NaN を返す。**
  // 呼び手は全て `> 閾値` で判定するので、NaN は「画面が変わらなかった」に化ける
  // ＝壊れたスクリーンショットが「HID が死んでいる」の偽アラームになる。ここで落とす
  if (width <= 0 || height <= 0) {
    throw new Error(`寸法が不正: ${width}x${rawHeight}`);
  }
  if (offset + width * height * 4 > buf.length) {
    throw new Error('ピクセルデータが足りない');
  }
  return {width, height, offset, topDown, buf};
}

/**
 * 2 枚の変化ピクセル割合 [0,1]。
 *
 * `tolerance` はチャネル差の許容。**0 にしない** — 実機の描画は同じ画面でも
 * 1〜2 の差が乗ることがあり、そこを拾うと常に「変化した」になる。
 */
function diffRatio(bmpA, bmpB, tolerance = 12) {
  const a = decodeBmp(bmpA);
  const b = decodeBmp(bmpB);
  if (a.width !== b.width || a.height !== b.height || a.topDown !== b.topDown) {
    throw new Error(
      `寸法が違う: ${a.width}x${a.height} vs ${b.width}x${b.height}`
    );
  }
  const total = a.width * a.height;
  const pa = a.buf;
  const pb = b.buf;
  let ia = a.offset;
  let ib = b.offset;
  let changed = 0;
  for (let i = 0; i < total; i++, ia += 4, ib += 4) {
    // BGRA。アルファは simctl が常に不透明で出すので見ない
    const d0 = Math.abs(pa[ia] - pb[ib]);
    const d1 = Math.abs(pa[ia + 1] - pb[ib + 1]);
    const d2 = Math.abs(pa[ia + 2] - pb[ib + 2]);
    if (d0 > tolerance || d1 > tolerance || d2 > tolerance) changed++;
  }
  return changed / total;
}

module.exports = {decodeBmp, diffRatio};
