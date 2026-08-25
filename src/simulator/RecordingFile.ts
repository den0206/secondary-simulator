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
 *
 * ビュー録画（webview の MediaRecorder）は mp4 と webm のどちらにもなるので、
 * **先頭のバイト列で見分けてから検査する**。形式を決め打ちすると、webm を
 * 「moov が無い」と落とす（毎回警告が出て番人が信用されなくなる）か、
 * mp4 の検査を外す（本来の目的を失う）かのどちらかになる。
 */
export type RecordingCheck =
  | {ok: true}
  | {
      ok: false;
      reason: 'unreadable' | 'empty' | 'unfinalized' | 'no-moov' | 'no-cluster';
    };

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

/** EBML（webm / matroska）の先頭 4 バイト。 */
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/** Cluster（映像が入る塊）の ID。1 つも無ければ絵が入っていない。 */
const WEBM_CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

/**
 * webm で Cluster を探す範囲。EBML ヘッダ・Segment・Tracks の後ろに来るので
 * 先頭のごく一部で足りる。**ファイル全体は読まない**（録画は数百 MB になりうる）。
 */
const WEBM_SCAN_BYTES = 4 * 1024 * 1024;
const WEBM_SCAN_CHUNK = 64 * 1024;

/**
 * 録画ファイルが再生できる形になっているかを見る。
 *
 * mp4 は `moov`（再生に要る索引）、webm は Cluster（映像の塊）の有無で判定する。
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
    {
      // 形式を見分ける。EBML でなければ mp4 として box を辿る（従来どおり）。
      const {bytesRead} = await handle.read(header, 0, HEADER_BYTES, 0);
      if (bytesRead >= 4 && header.subarray(0, 4).equals(EBML_MAGIC)) {
        return await verifyWebm(handle, fileSize);
      }
    }
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

/**
 * webm（MediaRecorder の出力）に映像の塊が入っているかを見る。
 *
 * MediaRecorder はストリーミング向けの webm を書くので、長さも Cues も入らない
 * （＝「未完成」の判定に使えない）。**チャンクを 1 つでも落とすと壊れる**という
 * 性質は連番の欠落として書き込み側（`ViewRecording.ts`）が捉えるので、ここでは
 * 「絵が 1 つも入っていないファイルを保存できたと言わない」ところだけを見る。
 *
 * 先頭から最大 4MB を 64KB ずつ読み、境界をまたぐ ID のために 3 バイト重ねる。
 */
async function verifyWebm(
  handle: fs.FileHandle,
  fileSize: number
): Promise<RecordingCheck> {
  const buffer = Buffer.alloc(WEBM_SCAN_CHUNK);
  const limit = Math.min(fileSize, WEBM_SCAN_BYTES);
  const overlap = WEBM_CLUSTER_ID.length - 1;
  let offset = 0;
  let carry = Buffer.alloc(0);

  while (offset < limit) {
    const {bytesRead} = await handle.read(
      buffer,
      0,
      Math.min(WEBM_SCAN_CHUNK, limit - offset),
      offset
    );
    if (bytesRead <= 0) break;
    const window = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
    if (window.includes(WEBM_CLUSTER_ID)) return {ok: true};
    carry = window.subarray(Math.max(0, window.length - overlap));
    offset += bytesRead;
  }
  return {ok: false, reason: 'no-cluster'};
}
