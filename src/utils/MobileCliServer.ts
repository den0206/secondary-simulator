import {ChildProcess, execFileSync, spawn} from 'node:child_process';
import {Logger} from './Logger';

export class MobileCliServer {
  private static DEFAULT_SERVER_PORT = 12000;
  private static SERVER_STARTUP_TIMEOUT_MS = 10000; // 10 seconds
  private static SERVER_HEALTH_CHECK_INTERVAL_MS = 200; // 200ms between checks

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
            execFileSync(binaryPath, ['--version']);
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
      Logger.info('Using npx to run mobilecli');
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
    // 再利用したときに接続の度へ 101 ポートの走査が戻ってくる。
    if (this.serverReady && (await this.checkServerHealth(this.serverPort))) {
      return;
    }
    this.serverReady = false;

    const rangeStart = MobileCliServer.DEFAULT_SERVER_PORT;
    const rangeEnd = MobileCliServer.DEFAULT_SERVER_PORT + 100;

    // 既存の稼働中サーバを範囲全体から探して再利用する（default ポートだけでなく、
    // 過去に別ポートで起動したものも拾えるようにする）。
    // /health は並列に叩いて待ち時間を畳む（直列だと最悪 101 秒かかる）。
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

    const args =
      this.mobilecliPath === 'npx'
        ? [
            '-y',
            // RPC 名は版で変わるので @latest は使わない。
            // ピンは package.json / インストール済み版から取る
            this.npxPackageSpec(),
            'server',
            'start',
            '--cors',
            '--listen',
            `localhost:${this.serverPort}`,
          ]
        : [
            '-v',
            'server',
            'start',
            '--cors',
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
    if (this.mobilecliServerProcess) {
      this.mobilecliServerProcess.kill();
      this.mobilecliServerProcess = null;
      Logger.info('mobilecli server stopped');
    }
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
