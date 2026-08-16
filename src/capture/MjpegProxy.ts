import * as http from 'node:http';
import {Logger} from '../utils/Logger';

/**
 * MJPEG 直結プロキシ（Phase 2）。
 *
 * webview の `<img src="http://localhost:PORT/stream?device=UDID">` から GET されると、
 * mobilecli の `POST /rpc screencapture(mjpeg)` へ中継し、multipart ストリームをそのまま
 * pipe で返す。これによりフレームが拡張ホストの postMessage を経由しなくなり、
 * Chromium が multipart をネイティブ復号する（JS 側の手動パースが不要）。
 *
 * 画像の <img> 表示に CORS は不要（canvas 読み出しをしないため）。
 */
export class MjpegProxy {
  static readonly MAX_PORT_TRIES = 20;

  private server: http.Server | null = null;
  private port = 0;

  constructor(private readonly mobileCliPort: number) {}

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  /** preferredPort から順に空きを探して listen する。実際に使うポートを返す。 */
  async start(
    preferredPort: number,
    maxTries = MjpegProxy.MAX_PORT_TRIES
  ): Promise<number> {
    if (this.server) return this.port;
    for (let p = preferredPort; p < preferredPort + maxTries; p++) {
      try {
        await this.listen(p);
        this.port = p;
        Logger.info(`MJPEG proxy listening on ${p}`);
        return p;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
        throw err;
      }
    }
    throw new Error('MJPEG proxy: 空きポートが見つからない');
  }

  private listen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const deviceId = url.searchParams.get('device');
    if (!deviceId) {
      res.writeHead(400);
      res.end('device query param required');
      return;
    }

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'screencapture',
      params: {format: 'mjpeg', deviceId},
    });

    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: this.mobileCliPort,
        path: '/rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (up) => {
        res.writeHead(200, {
          'Content-Type':
            up.headers['content-type'] ??
            'multipart/x-mixed-replace; boundary=--BoundaryString',
          'Cache-Control': 'no-cache, private',
          Connection: 'close',
          Pragma: 'no-cache',
        });
        up.pipe(res);
      }
    );

    upstream.on('error', (err) => {
      Logger.error('MJPEG proxy upstream error', err);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });

    // クライアント切断時に上流も止める
    res.on('close', () => upstream.destroy());
    upstream.write(body);
    upstream.end();
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
    this.port = 0;
  }
}
