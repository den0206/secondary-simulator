/**
 * multipart/x-mixed-replace（MJPEG）のインクリメンタルパーサ。
 *
 * MjpegCapture から解析だけを切り出したもの。ネットワークに触らないので単体テストできる。
 *
 * 旧実装との違い（docs/project-review.md §2.1）:
 * - バッファ全体を毎チャンク `TextDecoder` で文字列化していた。JPEG のバイト列を UTF-8 と
 *   して解釈すると複数バイトが 1 文字へ潰れるため、`indexOf` が返す文字位置とバイト位置が
 *   ずれる。境界探索はバイト列のまま行う。
 * - チャンク毎に `new Uint8Array(len)` で作り直し、`slice` で先頭を削っていた（O(n²)）。
 *   読み出し位置 `head` を進めるだけにして、詰め直しは必要なときだけ行う。
 * - `Content-Length` が無いパートで直前の値を使い回していた。パート毎にリセットする。
 * - boundary をソース中に固定していた。レスポンスの Content-Type から取る。
 */

/** 1 パート = ヘッダ + 本体。 */
export interface MjpegPart {
  contentType: string;
  data: Uint8Array;
}

export interface MjpegParserOptions {
  /** 本体の上限。超えるパートは捨てる（既定 10MB）。 */
  maxPartSize?: number;
  /** バッファの上限。超えたら壊れた入力とみなす（既定 10MB）。 */
  maxBufferSize?: number;
}

/** パーサが壊れた入力を検出したときに投げる。呼び出し側はストリームを張り直す。 */
export class MjpegParseError extends Error {}

const DEFAULT_MAX = 10 * 1024 * 1024;
const CR = 0x0d;
const LF = 0x0a;

/**
 * レスポンスの Content-Type から boundary を取り出す。
 * 例: `multipart/x-mixed-replace; boundary=BoundaryString` → `--BoundaryString`
 * 値が引用符で囲まれている場合も剥がす。見つからなければ null。
 */
export function parseBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  if (!m) return null;
  const raw = m[2].trim();
  if (!raw) return null;
  // 仕様上 boundary 行は `--` + 値。値自体が `--` で始まる実装もあるので二重付与しない。
  return raw.startsWith('--') ? raw : `--${raw}`;
}

export class MjpegParser {
  private readonly maxPartSize: number;
  private readonly maxBufferSize: number;
  private readonly boundaryBytes: Uint8Array;

  private buf: Uint8Array = new Uint8Array(0);
  /** buf のうち未処理データの開始位置。slice せずここを進める。 */
  private head = 0;
  /** 本体読み取り中か。false ならバウンダリ待ち。 */
  private inBody = false;
  private contentLength = -1;
  private contentType = '';
  private body: Uint8Array | null = null;
  private bodyFilled = 0;

  constructor(boundary: string, options: MjpegParserOptions = {}) {
    if (!boundary) throw new Error('boundary が空');
    this.boundaryBytes = new TextEncoder().encode(boundary);
    this.maxPartSize = options.maxPartSize ?? DEFAULT_MAX;
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX;
  }

  /** 保持しているバイト数（テストと上限監視用）。 */
  get bufferedBytes(): number {
    return this.buf.length - this.head;
  }

  /**
   * 受信チャンクを取り込み、完成したパートを返す。
   * 壊れた入力（上限超過・不正な Content-Length）では MjpegParseError を投げる。
   */
  push(chunk: Uint8Array): MjpegPart[] {
    this.append(chunk);
    const parts: MjpegPart[] = [];
    // 1 チャンクに複数フレームが入ることがあるので、進めなくなるまで回す。
    while (this.step(parts)) {
      /* 進んだ分だけ繰り返す */
    }
    // 消費済みの先頭は次の append が subarray(head) で落とすので、ここでは詰め直さない。
    return parts;
  }

  /** ストリームを張り直すときに呼ぶ。保持中のバイトを捨てる。 */
  reset(): void {
    this.buf = new Uint8Array(0);
    this.head = 0;
    this.inBody = false;
    this.contentLength = -1;
    this.contentType = '';
    this.body = null;
    this.bodyFilled = 0;
  }

  private append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (this.bufferedBytes + chunk.length > this.maxBufferSize) {
      throw new MjpegParseError(
        `バッファ上限 ${this.maxBufferSize} バイトを超えた`
      );
    }
    const next = new Uint8Array(this.bufferedBytes + chunk.length);
    next.set(this.buf.subarray(this.head));
    next.set(chunk, this.bufferedBytes);
    this.buf = next;
    this.head = 0;
  }

  /** 1 段階だけ進める。何か進んだら true。 */
  private step(parts: MjpegPart[]): boolean {
    return this.inBody ? this.readBody(parts) : this.readHeader();
  }

  /** バウンダリとヘッダを読む。ヘッダが揃っていなければ false。 */
  private readHeader(): boolean {
    const boundaryAt = this.indexOfBytes(this.boundaryBytes, this.head);
    if (boundaryAt < 0) {
      // バウンダリの一部が次チャンクに跨る可能性があるので、末尾だけ残して捨てる。
      const keep = this.boundaryBytes.length - 1;
      const drop = this.buf.length - keep - this.head;
      if (drop > 0) this.head += drop;
      return false;
    }

    const headerEnd = this.indexOfHeaderEnd(boundaryAt + this.boundaryBytes.length);
    if (headerEnd < 0) return false; // ヘッダがまだ揃っていない

    // ヘッダ部分だけを文字列化する。ここは ASCII なのでバイト位置と一致する。
    const headerBytes = this.buf.subarray(
      boundaryAt + this.boundaryBytes.length,
      headerEnd
    );
    const headers = new TextDecoder('utf-8').decode(headerBytes);

    // パート毎に必ずリセットする（前のパートの値を引き継がない）。
    this.contentLength = -1;
    this.contentType = '';

    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headers);
    if (lengthMatch) this.contentLength = parseInt(lengthMatch[1], 10);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
    if (typeMatch) this.contentType = typeMatch[1].trim();

    if (this.contentLength < 0) {
      throw new MjpegParseError('パートに Content-Length が無い');
    }
    if (this.contentLength === 0 || this.contentLength > this.maxPartSize) {
      throw new MjpegParseError(`不正な Content-Length: ${this.contentLength}`);
    }

    this.head = headerEnd + 4; // CRLF CRLF を飛ばす
    this.inBody = true;
    this.body = new Uint8Array(this.contentLength);
    this.bodyFilled = 0;
    return true;
  }

  /** 本体を読む。まだ足りなければ false。 */
  private readBody(parts: MjpegPart[]): boolean {
    const body = this.body;
    if (!body) {
      this.inBody = false;
      return true;
    }
    const want = this.contentLength - this.bodyFilled;
    const have = this.buf.length - this.head;
    const take = Math.min(want, have);
    if (take === 0) return false;

    body.set(this.buf.subarray(this.head, this.head + take), this.bodyFilled);
    this.bodyFilled += take;
    this.head += take;

    if (this.bodyFilled < this.contentLength) return false;

    parts.push({contentType: this.contentType, data: body});
    this.inBody = false;
    this.body = null;
    this.bodyFilled = 0;
    return true;
  }

  /** from 以降で needle が最初に現れるバイト位置。無ければ -1。 */
  private indexOfBytes(needle: Uint8Array, from: number): number {
    const hay = this.buf;
    const last = hay.length - needle.length;
    outer: for (let i = from; i <= last; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /** from 以降で CRLFCRLF が始まる位置。無ければ -1。 */
  private indexOfHeaderEnd(from: number): number {
    const hay = this.buf;
    for (let i = from; i + 3 < hay.length; i++) {
      if (
        hay[i] === CR &&
        hay[i + 1] === LF &&
        hay[i + 2] === CR &&
        hay[i + 3] === LF
      ) {
        return i;
      }
    }
    return -1;
  }
}
