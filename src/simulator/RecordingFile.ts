import * as fs from 'fs/promises';

/**
 * 書き出し終わった録画ファイルの検査。
 *
 * mobilecli の停止（`device.screenrecord.stop`）が成功しても、**端末側の録画が
 * finalize されていなければ再生できない mp4 が残る**。Android の `MPEG4Writer` は
 * 録画中に `ftyp` と `mdat` だけを書き、`mdat` のサイズ欄は `"????????"`
 * （0x3F×8）のまま、`moov` 用に確保した `free` は空のままにしておく。停止時に
 * サイズの確定と `moov` の書き込みをまとめてやってファイルを完成させる。
 * この最終処理が飛ぶと、映像データは無傷なのに索引が無く、どのプレイヤーも開けない。
 *
 * 実際に mobilecli 0.1.64 がこれを踏んでいた（端末側ではなく手元の adb クライアントへ
 * SIGINT を送っていたため、端末の `screenrecord` へ届かなかった）。**同じことが
 * 起きたときに黙って壊れたファイルを掴ませない**ための番人がここ。
 */
export type RecordingCheck =
  | {ok: true}
  | {ok: false; reason: 'unreadable' | 'empty' | 'unfinalized' | 'no-moov'};

/**
 * 先頭から box を辿るだけなので、ファイル全体は読まない（録画は数百 MB になりうる）。
 * 1 box あたり 16 バイト読んでサイズぶん飛ぶ。
 */
const HEADER_BYTES = 16;

/**
 * 辿る box 数の上限。通常の mp4 の最上位 box は数個（`ftyp` / `free` / `mdat` / `moov`）で、
 * ここまで来ることはない。**壊れた入力で回り続けないための蓋**。
 */
const MAX_BOXES = 128;

/**
 * `moov`（再生に要る索引）が入っているかを見る。
 *
 * @param filePath 検査するファイル。開けないだけでも失敗として返す（例外は投げない）
 */
export async function verifyRecording(
  filePath: string
): Promise<RecordingCheck> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    return {ok: false, reason: 'unreadable'};
  }

  try {
    const fileSize = (await handle.stat()).size;
    if (fileSize === 0) return {ok: false, reason: 'empty'};

    const header = Buffer.alloc(HEADER_BYTES);
    let offset = 0;

    for (let i = 0; i < MAX_BOXES; i++) {
      const {bytesRead} = await handle.read(header, 0, HEADER_BYTES, offset);
      // box ヘッダにも足りない = ここで終わり。moov は見つからなかった
      if (bytesRead < 8) return {ok: false, reason: 'no-moov'};

      if (header.toString('latin1', 4, 8) === 'moov') return {ok: true};

      let size: number = header.readUInt32BE(0);
      if (size === 1) {
        // 64bit 拡張サイズ。MPEG4Writer が録画中に書く仮の値（"????????"）は
        // ファイル長を軽く超えるので、ここで落ちる。
        if (bytesRead < HEADER_BYTES) return {ok: false, reason: 'unfinalized'};
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(fileSize - offset)) {
          return {ok: false, reason: 'unfinalized'};
        }
        size = Number(large);
      } else if (size === 0) {
        // 「末尾まで伸びる box」。この後ろに moov は無い
        return {ok: false, reason: 'no-moov'};
      }

      if (size < 8) return {ok: false, reason: 'unfinalized'};
      offset += size;
      if (offset > fileSize) return {ok: false, reason: 'unfinalized'};
      if (offset === fileSize) return {ok: false, reason: 'no-moov'};
    }

    return {ok: false, reason: 'no-moov'};
  } finally {
    await handle.close();
  }
}
