import {randomBytes, timingSafeEqual} from 'node:crypto';
import * as http from 'node:http';
import {Logger} from '../utils/Logger';

/**
 * MJPEG 直結プロキシ（Phase 2）。
 *
 * webview の `<img src="http://localhost:PORT/stream?device=UDID">` から GET されると、
 * mobilecli の `POST /rpc device.screencapture(mjpeg)` でセッションを開き、返ってきた
 * `/stream?s=...` の multipart をそのまま pipe で返す。フレームが拡張ホストの postMessage を経由しなくなり、
 * Chromium が multipart をネイティブ復号する（JS 側の手動パースが不要）。
 *
 * 画像の <img> 表示に CORS は不要（canvas 読み出しをしないため）。
 *
 * 127.0.0.1 で listen するので外部からは届かないが、同じマシンの任意のプロセス・
 * 任意のブラウザタブからは届く。UDID を当てるだけで画面が覗けてしまうため、
 * 起動毎に生成するトークンを URL に載せ、一致しないリクエストは 404 で落とす。
 */
export class MjpegProxy {
  static readonly MAX_PORT_TRIES = 20;

  private server: http.Server | null = null;
  private port = 0;
  /** プロセス起動毎に変わる。webview へ渡す URL 以外からは中継させない。 */
  private readonly token = randomBytes(24).toString('hex');

  constructor(private readonly mobileCliPort: number) {}

  getPort(): number {
    return this.port;
  }

  /** webview へ渡すストリーム URL。トークンはここでしか漏れない。 */
  streamUrl(deviceId: string): string {
    return `http://localhost:${this.port}/stream?device=${encodeURIComponent(
      deviceId
    )}&t=${this.token}`;
  }

  private isTokenValid(given: string | null): boolean {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
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
      const server = http.createServer(
        (req, res) => void this.handle(req, res)
      );
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // 経路とトークンが揃わないものは、存在自体を伏せて 404 で落とす
    if (url.pathname !== '/stream' || !this.isTokenValid(url.searchParams.get('t'))) {
      res.writeHead(404);
      res.end();
      return;
    }
    const deviceId = url.searchParams.get('device');
    if (!deviceId) {
      res.writeHead(400);
      res.end('device query param required');
      return;
    }

    try {
      const sessionUrl = await this.openSession(deviceId);
      // クライアントが既に切れていたらセッションを開いたまま中継しない
      if (res.writableEnded || res.destroyed) return;

      const upstream = http.get(
        {host: '127.0.0.1', port: this.mobileCliPort, path: sessionUrl},
        (up) => {
          res.writeHead(200, {
            'Content-Type':
              up.headers['content-type'] ??
              'multipart/x-mixed-replace; boundary=BoundaryString',
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
    } catch (err) {
      Logger.error('MJPEG proxy session error', err as Error);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  }

  /**
   * mobilecli 0.1.x の `device.screencapture` はストリーム本体ではなく
   * `/stream?s=...` のセッション URL を返す。multipart はその GET 側で流れる。
   */
  private async openSession(deviceId: string): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${this.mobileCliPort}/rpc`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'device.screencapture',
        params: {format: 'mjpeg', deviceId},
      }),
    });
    const body = (await response.json()) as {
      result?: {sessionUrl?: string};
      error?: {message?: string; data?: string};
    };
    const sessionUrl = body.result?.sessionUrl;
    if (!sessionUrl) {
      throw new Error(
        body.error?.data ??
          body.error?.message ??
          'device.screencapture が sessionUrl を返さなかった'
      );
    }
    return sessionUrl;
  }

  dispose(): void {
    // MJPEG は終わらないストリームなので、close() だけでは接続が残りポートも解放されない
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
    this.port = 0;
  }
}
