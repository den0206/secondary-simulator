import {Logger} from '../utils/Logger';
import {CaptureStrategy, FrameCallback} from './CaptureStrategy';

/**
 * MJPEGストリーミング方式のキャプチャ実装
 * mobilecliのMJPEGストリームを使用
 */
export class MjpegCapture implements CaptureStrategy {
  private static readonly MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
  private static readonly MAX_IMAGE_DATA_SIZE = 10 * 1024 * 1024; // 10MB
  private static readonly BOUNDARY_TIMEOUT_MS = 5000; // 5秒

  private deviceId: string | null = null;
  private frameCallback: FrameCallback | null = null;
  private isCapturing: boolean = false;
  private serverPort: number;
  private streamController: AbortController | null = null;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private frameCount: number = 0;
  private lastFpsUpdate: number = 0;
  private currentFps: number = 0;
  private startTime: number = 0;
  private buffer: Uint8Array | null = null;
  private imageData: Uint8Array | null = null;
  private lastBoundaryFoundTime: number = 0;
  // 利用者がキャプチャ継続を望んでいるか（isCapturing は現在ストリーム中かで別物）。
  // ストリームが異常終了しても wantCapture が true なら自動再接続する。
  private wantCapture: boolean = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private streamGen = 0;
  private static readonly RECONNECT_DELAY_MS = 500;

  constructor(serverPort: number) {
    this.serverPort = serverPort;
  }

  setDevice(deviceId: string): void {
    this.deviceId = deviceId;
  }

  onFrame(callback: FrameCallback): void {
    this.frameCallback = callback;
  }

  async start(): Promise<void> {
    if (!this.deviceId) {
      throw new Error('No device selected');
    }

    if (this.isCapturing) {
      return;
    }

    this.wantCapture = true;
    this.streamGen++;
    const gen = this.streamGen;
    this.isCapturing = true;
    this.frameCount = 0;
    this.lastFpsUpdate = Date.now();
    this.currentFps = 0;
    this.startTime = Date.now();

    Logger.info(`Starting MJPEG stream for device: ${this.deviceId}`);
    await this.startMjpegStream(gen);
  }

  stop(): void {
    this.wantCapture = false;
    this.streamGen++;
    this.isCapturing = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopMjpegStream();
    Logger.info('MJPEG capture stopped');
  }

  updateConfig(): void {
    // MJPEGストリーミングでは設定変更は再起動が必要
    if (this.wantCapture && this.deviceId) {
      this.stop();
      void this.start().catch((e) =>
        Logger.error('Failed to restart capture on config change', e as Error)
      );
    }
  }

  // ストリームが異常終了したとき、利用者がまだ継続を望んでいれば再接続する。
  private scheduleReconnect(): void {
    if (!this.wantCapture || this.reconnectTimer) return;
    const gen = this.streamGen;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantCapture || !this.deviceId || gen !== this.streamGen) return;
      Logger.info('Reconnecting MJPEG stream');
      this.isCapturing = true;
      void this.startMjpegStream(gen).catch((e) =>
        Logger.error('MJPEG reconnect failed', e as Error)
      );
    }, MjpegCapture.RECONNECT_DELAY_MS);
  }

  dispose(): void {
    this.stop();
    this.frameCallback = null;
    this.deviceId = null;
  }

  private async startMjpegStream(gen: number): Promise<void> {
    if (!this.deviceId) {
      return;
    }
    if (gen !== this.streamGen) {
      return;
    }

    try {
      const response = await fetch(`http://localhost:${this.serverPort}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          method: 'screencapture',
          id: '1',
          jsonrpc: '2.0',
          params: {
            format: 'mjpeg',
            deviceId: this.deviceId,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('ReadableStream not supported');
      }

      this.streamController = new AbortController();
      const reader = response.body.getReader();
      this.streamReader = reader;

      // MJPEGストリームを処理
      this.processMjpegStream(reader, gen);
    } catch (error) {
      Logger.error('Failed to start MJPEG stream', error as Error);
      if (gen === this.streamGen) {
        this.isCapturing = false;
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  private stopMjpegStream(): void {
    if (this.streamController) {
      this.streamController.abort();
      this.streamController = null;
    }

    if (this.streamReader) {
      this.streamReader.cancel();
      this.streamReader = null;
    }

    // バッファのクリア（メモリリーク防止）
    this.buffer = null;
    this.imageData = null;
  }

  private async processMjpegStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    gen: number
  ): Promise<void> {
    const boundary = '--BoundaryString';
    this.buffer = new Uint8Array();
    let inImage = false;
    this.imageData = new Uint8Array();
    let contentLength = 0;
    let contentType = '';
    let bytesRead = 0;
    this.lastBoundaryFoundTime = Date.now();

    Logger.info('Starting MJPEG stream processing');

    try {
      while (this.isActive) {
        const {done, value} = await reader.read();

        if (done) {
          Logger.info('MJPEG stream ended');
          break;
        }

        // バッファサイズチェック（メモリ保護）
        const currentBufferSize = this.buffer?.length || 0;
        if (currentBufferSize + value.length > MjpegCapture.MAX_BUFFER_SIZE) {
          Logger.warn(
            `Buffer size exceeded limit (${
              currentBufferSize + value.length
            } bytes). Resetting stream.`
          );
          this.resetStream(reader);
          break;
        }

        // バウンダリ検出のタイムアウトチェック
        const timeSinceLastBoundary = Date.now() - this.lastBoundaryFoundTime;
        if (
          !inImage &&
          timeSinceLastBoundary > MjpegCapture.BOUNDARY_TIMEOUT_MS
        ) {
          Logger.warn(
            `Boundary not found for ${timeSinceLastBoundary}ms. Resetting stream.`
          );
          this.resetStream(reader);
          break;
        }

        // バッファにデータを追加
        const newBuffer: Uint8Array = new Uint8Array(
          currentBufferSize + value.length
        );
        if (this.buffer) {
          newBuffer.set(this.buffer);
        }
        newBuffer.set(value, currentBufferSize);
        this.buffer = newBuffer;

        let processedData = false;
        while (true) {
          if (!inImage) {
            // バウンダリを探す
            const bufferString = new TextDecoder().decode(
              this.buffer || new Uint8Array()
            );
            const boundaryIndex = bufferString.indexOf(boundary);
            if (boundaryIndex === -1) {
              break;
            }

            // バウンダリが見つかった時刻を更新
            this.lastBoundaryFoundTime = Date.now();

            // ヘッダーの終わりを探す
            const headerEndIndex = bufferString.indexOf(
              '\r\n\r\n',
              boundaryIndex
            );
            if (headerEndIndex === -1) {
              break;
            }

            // ヘッダーを解析
            const headers = bufferString.substring(
              boundaryIndex + boundary.length,
              headerEndIndex
            );
            const contentLengthMatch = headers.match(
              /Content-Length:\s*(\d+)/i
            );
            if (contentLengthMatch) {
              contentLength = parseInt(contentLengthMatch[1], 10);
              // Content-Lengthの妥当性チェック
              if (
                contentLength <= 0 ||
                contentLength > MjpegCapture.MAX_IMAGE_DATA_SIZE
              ) {
                Logger.warn(
                  `Invalid Content-Length: ${contentLength}. Resetting stream.`
                );
                this.resetStream(reader);
                break;
              }
            }

            const contentTypeMatch = headers.match(
              /Content-Type:\s*([^\r\n]+)/i
            );
            contentType = contentTypeMatch ? contentTypeMatch[1].trim() : '';

            // ヘッダー部分をバッファから削除
            const headerEndBytes = headerEndIndex + 4;
            if (this.buffer) {
              this.buffer = this.buffer.slice(headerEndBytes);
            }
            inImage = true;
            this.imageData = new Uint8Array();
            bytesRead = 0;
            processedData = true;
          }

          if (inImage) {
            // 画像データを読み取る
            const remainingBytes = contentLength - bytesRead;
            const bytesToRead = Math.min(
              remainingBytes,
              this.buffer?.length || 0
            );

            if (bytesToRead === 0) {
              break;
            }

            // 画像データサイズチェック（メモリ保護）
            const currentImageDataSize = this.imageData?.length || 0;
            if (
              currentImageDataSize + bytesToRead >
              MjpegCapture.MAX_IMAGE_DATA_SIZE
            ) {
              Logger.warn(
                `Image data size exceeded limit (${
                  currentImageDataSize + bytesToRead
                } bytes). Resetting stream.`
              );
              this.resetStream(reader);
              break;
            }

            const newImageData: Uint8Array = new Uint8Array(
              currentImageDataSize + bytesToRead
            );
            if (this.imageData) {
              newImageData.set(this.imageData);
            }
            if (this.buffer) {
              newImageData.set(
                this.buffer.slice(0, bytesToRead),
                this.imageData?.length || 0
              );
            }
            this.imageData = newImageData;

            bytesRead += bytesToRead;
            if (this.buffer) {
              this.buffer = this.buffer.slice(bytesToRead);
            }
            processedData = true;

            if (bytesRead >= contentLength) {
              // フレームが完成
              if (contentType === 'image/jpeg' && this.imageData) {
                // フレームを即座に処理（遅延を最小化）
                this.displayMjpegImage(this.imageData);
              } else if (this.imageData) {
                // 非JPEGフレーム（JSON-RPC通知など）
                const bodyText = new TextDecoder().decode(this.imageData);
                Logger.debug(
                  `Non-JPEG frame: ${contentType}, body: ${bodyText}`
                );
              }

              inImage = false;
              this.imageData = new Uint8Array();
              bytesRead = 0;
            }
          }
        }

        // フレーム処理を最適化：不要な遅延を削除
        // 連続したフレーム処理を可能にするため、awaitを削除
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        Logger.info('MJPEG stream aborted');
      } else {
        Logger.error('Error processing MJPEG stream', error);
      }
    } finally {
      // 新しい世代が始まっているなら、そのストリームのフラグを壊さない
      if (gen === this.streamGen) {
        this.isCapturing = false;
        this.scheduleReconnect();
      }
    }
  }

  private displayMjpegImage(imageData: Uint8Array): void {
    try {
      // MJPEGストリームから受け取ったJPEGデータをそのまま使用
      // sharpでの再エンコードは不要（遅延の原因となるため削除）

      // FPS計算
      this.frameCount++;
      const now = Date.now();
      const elapsed = now - this.lastFpsUpdate;

      if (elapsed >= 1000) {
        this.currentFps = Math.round((this.frameCount * 1000) / elapsed);
        this.frameCount = 0;
        this.lastFpsUpdate = now;
      }

      const latency = now - this.startTime;

      // フレームをコールバックに送信（JPEGデータをそのまま使用）
      if (this.frameCallback) {
        this.frameCallback(imageData, {
          fps: this.currentFps,
          latency,
        });
      }
    } catch (error) {
      Logger.error('Error displaying MJPEG image', error as Error);
    }
  }

  private get isActive(): boolean {
    return this.isCapturing;
  }

  /**
   * ストリームをリセット（異常な状況でのメモリ保護）
   */
  private resetStream(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    Logger.warn('Resetting MJPEG stream due to memory protection');
    this.buffer = null;
    this.imageData = null;
    this.lastBoundaryFoundTime = Date.now();
    // リーダーをキャンセルして再起動を促す
    reader.cancel().catch((err) => {
      Logger.debug(`Error canceling reader during reset: ${err}`);
    });
    this.isCapturing = false;
  }
}
