import {ChildProcess, spawn} from 'node:child_process';
import {Logger} from './Logger';

export class MobileCliServer {
  private static DEFAULT_SERVER_PORT = 12000;
  private static SERVER_STARTUP_TIMEOUT_MS = 10000; // 10 seconds
  private static SERVER_HEALTH_CHECK_INTERVAL_MS = 200; // 200ms between checks
  private static KILL_GRACE_MS = 2000; // SIGTERM から SIGKILL までの猶予
  /**
   * 走査するポート数。無関係なローカルサービスへ JSON を投げる範囲でもあるので
   * 広げない（同時に 10 個 mobilecli が立つことはない）。
   */
  private static PORT_RANGE = 10;

  private mobilecliPath: string | null = null;
  private serverPort: number = MobileCliServer.DEFAULT_SERVER_PORT;
  private mobilecliServerProcess: ChildProcess | null = null;
  /**
   * 使えるサーバを掴んでいるか。自分で spawn した場合と、既存サーバを再利用した場合の
   * 両方で true になる。プロセスの有無だけで判定すると、再利用時に毎回ポート走査
   * （101 ポート × 2 リクエスト）をやり直すことになる。
   */
  private serverReady = false;

  constructor() {
    this.mobilecliPath = this.findMobilecliPath();
  }

  private findMobilecliPath(): string | null {
    try {
      const fs = require('fs');
      const path = require('path');

      // 1. node_modulesから探す（npmパッケージとしてインストールされた場合）
      try {
        const packageJsonPath = require.resolve(
          '@mobilenext/mobilecli/package.json'
        );
        const packageDir = path.dirname(packageJsonPath);
        const binDir = path.join(packageDir, 'bin');

        // プラットフォーム別のバイナリ名を決定
        let binaryName: string;
        if (process.platform === 'win32') {
          binaryName = 'mobilecli-windows-amd64.exe';
        } else if (process.platform === 'darwin') {
          binaryName =
            process.arch === 'arm64'
              ? 'mobilecli-darwin-arm64'
              : 'mobilecli-darwin-amd64';
        } else {
          // Linux
          binaryName =
            process.arch === 'arm64'
              ? 'mobilecli-linux-arm64'
              : 'mobilecli-linux-amd64';
        }

        const binaryPath = path.join(binDir, binaryName);
        if (fs.existsSync(binaryPath)) {
          try {
            // 実行可否は access で見る。この constructor は activate から呼ばれるので、
            // ここで子プロセスを起こすと拡張ホストが Gatekeeper 検証の分だけ止まる。
            fs.accessSync(binaryPath, fs.constants.X_OK);
            Logger.info(`Found mobilecli at: ${binaryPath}`);
            return binaryPath;
          } catch {
            // バイナリは存在するが実行できない場合は次を試す
          }
        }
      } catch {
        // node_modulesから見つからない場合は次を試す
      }

      // 2. npx経由で実行（フォールバック）
      // 実行時にネットワークから取得して実行することになるので、info では埋もれる。
      Logger.warn(
        'mobilecli の同梱バイナリが見つからないので npx で実行する' +
          '（版は固定するが、パッケージをネットワークから取得して実行する）'
      );
      return 'npx';
    } catch (error) {
      Logger.error('Failed to find mobilecli path', error as Error);
      // 最後の手段としてnpxを使用
      return 'npx';
    }
  }

  private async checkServerHealth(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://localhost:${port}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(1000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // 0.0.x は `devices`、0.1.x は `devices.list`。名前が通るサーバだけ再利用する。
  private async isRpcCompatible(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://localhost:${port}/rpc`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'devices.list',
          params: {includeOffline: false},
        }),
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as {result?: unknown; error?: unknown};
      return body.result != null && body.error == null;
    } catch {
      return false;
    }
  }

  // npx フォールバック用。ハードコードすると package.json の ^ と乖離する。
  private npxPackageSpec(): string {
    const path = require('path') as typeof import('path');
    const fs = require('fs') as typeof import('fs');
    try {
      const installed = require('@mobilenext/mobilecli/package.json') as {
        version?: string;
      };
      if (installed.version) {
        return `@mobilenext/mobilecli@${installed.version}`;
      }
    } catch {
      // node_modules に無いときだけ下へ
    }
    try {
      const pkgPath = path.join(__dirname, '..', '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const spec = pkg.dependencies?.['@mobilenext/mobilecli'];
      if (spec) {
        return `@mobilenext/mobilecli@${spec.replace(/^[~^]/, '')}`;
      }
    } catch {
      // 読めなければ最後の手段
    }
    return '@mobilenext/mobilecli@0.1.64';
  }

  private async waitForServerReady(
    port: number,
    timeoutMs: number
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const isHealthy = await this.checkServerHealth(port);
      if (isHealthy) {
        Logger.info(`mobilecli server is ready on port ${port}`);
        return;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, MobileCliServer.SERVER_HEALTH_CHECK_INTERVAL_MS)
      );
    }

    throw new Error(
      `mobilecli server failed to become ready within ${timeoutMs}ms`
    );
  }

  public async launchServer(): Promise<void> {
    if (!this.mobilecliPath) {
      throw new Error('mobilecli not found');
    }

    if (this.mobilecliServerProcess) {
      Logger.info('mobilecli server process already exists');
      return;
    }

    // 既に掴んだサーバが生きていれば走査ごと省く。ここを飛ばすと、外部サーバを
    // 再利用したときに接続の度へ PORT_RANGE 分の走査が戻ってくる。
    if (this.serverReady && (await this.checkServerHealth(this.serverPort))) {
      return;
    }
    this.serverReady = false;

    const rangeStart = MobileCliServer.DEFAULT_SERVER_PORT;
    const rangeEnd = MobileCliServer.DEFAULT_SERVER_PORT + MobileCliServer.PORT_RANGE - 1;

    // 既存の稼働中サーバを範囲全体から探して再利用する（default ポートだけでなく、
    // 過去に別ポートで起動したものも拾えるようにする）。
    // /health は並列に叩いて待ち時間を畳む（直列だと 1 ポート 1 秒待ちが積み上がる）。
    const health = await Promise.all(
      Array.from({length: rangeEnd - rangeStart + 1}, (_, i) =>
        this.checkServerHealth(rangeStart + i)
      )
    );

    // 0.0.x は RPC 名が違うので /health だけでは不十分。devices.list が通るものだけ使う。
    for (let i = 0; i < health.length; i++) {
      if (!health[i]) continue;
      const port = rangeStart + i;
      if (await this.isRpcCompatible(port)) {
        Logger.info(`Reusing running mobilecli server on port ${port}`);
        this.serverPort = port;
        this.serverReady = true;
        return;
      }
    }

    // 稼働中が無ければ空きポートで起動する（上の /health 結果を再利用する）
    const freeIndex = health.indexOf(false);
    if (freeIndex < 0) {
      throw new Error('No available port found');
    }
    this.serverPort = rangeStart + freeIndex;
    Logger.info(`Launching mobilecli server on port ${this.serverPort}...`);

    // `--cors` は付けない。付けると任意のブラウザタブから RPC を叩けて応答まで読める
    // （画面窃取・端末操作・録画の任意パス書き込み）。この拡張は CORS を要らない
    // ——拡張ホストは Node の fetch（オリジン無し）、webview は <img> だけで、
    // 画像読み込みは CORS の対象外（`MjpegProxy` 冒頭）。
    const args =
      this.mobilecliPath === 'npx'
        ? [
            // 取得したパッケージのインストールスクリプトは走らせない
            // （利用者のマシンでネットワーク越しのコードを実行する唯一の経路）
            '--ignore-scripts',
            '-y',
            // RPC 名は版で変わるので @latest は使わない。
            // ピンは package.json / インストール済み版から取る
            this.npxPackageSpec(),
            'server',
            'start',
            '--listen',
            `localhost:${this.serverPort}`,
          ]
        : [
            '-v',
            'server',
            'start',
            '--listen',
            `localhost:${this.serverPort}`,
          ];

    this.mobilecliServerProcess = spawn(this.mobilecliPath, args, {
      detached: false,
      stdio: 'pipe',
    });

    this.mobilecliServerProcess.stdout?.on('data', (data: Buffer) => {
      Logger.debug(`mobilecli server stdout: ${data.toString().trimEnd()}`);
    });

    this.mobilecliServerProcess.stderr?.on('data', (data: Buffer) => {
      Logger.debug(`mobilecli server stderr: ${data.toString().trimEnd()}`);
    });

    this.mobilecliServerProcess.on('close', (code: number) => {
      Logger.info(`mobilecli server process exited with code ${code}`);
      this.mobilecliServerProcess = null;
      this.serverReady = false;
    });

    this.mobilecliServerProcess.on('error', (error: Error) => {
      Logger.error(`mobilecli server error: ${error.message}`);
      this.mobilecliServerProcess = null;
      this.serverReady = false;
    });

    // サーバーの準備完了を待つ
    await this.waitForServerReady(
      this.serverPort,
      MobileCliServer.SERVER_STARTUP_TIMEOUT_MS
    );
    this.serverReady = true;
  }

  public stopServer(): void {
    this.serverReady = false;
    const proc = this.mobilecliServerProcess;
    this.mobilecliServerProcess = null;
    if (!proc) return;

    // SIGTERM を無視されると孤児として残り、ポートと数十 MB を占有し続ける。
    // 猶予を置いて SIGKILL する。
    proc.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        Logger.warn('mobilecli server が SIGTERM で終了しないため SIGKILL する');
        proc.kill('SIGKILL');
      }
    }, MobileCliServer.KILL_GRACE_MS);
    // このタイマーで拡張ホストの終了を遅らせない
    killTimer.unref?.();
    Logger.info('mobilecli server stopped');
  }

  public getServerPort(): number {
    return this.serverPort;
  }

  /** 使えるサーバを掴んでいるか。外部サーバを再利用している場合も true。 */
  public isServerRunning(): boolean {
    return this.serverReady;
  }

  public getPid(): number | undefined {
    return this.mobilecliServerProcess?.pid;
  }
}
