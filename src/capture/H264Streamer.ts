import {ChildProcess, spawn} from 'child_process';
import {Logger} from '../utils/Logger';
import {Platform} from '../simulator/types';

/**
 * シンプルなH.264 ESストリーマー
 * - SPS/PPS を検出して Webview に h264-config を送信
 * - NAL 単位で h264-chunk を送信（低遅延向け、キューは Webview 側がドロップ制御）
 */
export class H264Streamer {
  private platform: Platform;
  private deviceId: string;
  private postMessage: (msg: unknown) => void;
  private child: ChildProcess | null = null;
  private leftover: Buffer = Buffer.alloc(0);
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private configured = false;

  constructor(
    platform: Platform,
    deviceId: string,
    postMessage: (msg: unknown) => void
  ) {
    this.platform = platform;
    this.deviceId = deviceId;
    this.postMessage = postMessage;
  }

  start(): void {
    if (this.child) {
      return;
    }

    const args =
      this.platform === 'android'
        ? ['-s', this.deviceId, 'exec-out', 'screenrecord', '--output-format=h264', '-']
        : ['simctl', 'io', this.deviceId, 'recordVideo', '--type=h264', '-'];

    const cmd = this.platform === 'android' ? 'adb' : 'xcrun';
    Logger.info(`Starting H264 stream: ${cmd} ${args.join(' ')}`);

    this.child = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe']});

    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) =>
      Logger.debug(`H264 stderr: ${chunk.toString()}`)
    );
    this.child.on('exit', (code, signal) => {
      Logger.info(`H264 stream exit code=${code} signal=${signal}`);
      this.child = null;
    });
  }

  stop(): void {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.leftover = Buffer.alloc(0);
    this.sps = null;
    this.pps = null;
    this.configured = false;
  }

  dispose(): void {
    this.stop();
  }

  private onData(chunk: Buffer): void {
    this.leftover = Buffer.concat([this.leftover, chunk]);
    const nalUnits = this.extractAnnexBNals();

    for (const nal of nalUnits) {
      if (nal.length < 1) continue;
      const nalType = nal[0] & 0x1f;

      if (nalType === 7) {
        this.sps = nal;
      } else if (nalType === 8) {
        this.pps = nal;
      }

      if (!this.configured && this.sps && this.pps) {
        // Webview 側は description を AVCC 形式でなくとも受け取れるよう緩く処理する
        const description = Buffer.concat([this.sps, this.pps]);
        this.postMessage({
          type: 'h264-config',
          codec: 'avc1.42E01E',
          description: new Uint8Array(description),
        });
        this.configured = true;
      }

      // 低遅延のため NAL 単位で即送信
      this.postMessage({
        type: 'h264-chunk',
        data: new Uint8Array(nal),
        isKeyframe: nalType === 5, // IDR
      });
    }
  }

  /**
   * Annex-B スタートコード (0x000001 or 0x00000001) で NAL を切り出す
   */
  private extractAnnexBNals(): Buffer[] {
    const units: Buffer[] = [];
    let data = this.leftover;
    const startCodePattern = /(?:^|\x00\x00\x00|\x00\x00)01/g;

    let match: RegExpExecArray | null;
    const positions: number[] = [];

    while ((match = startCodePattern.exec(data.toString('binary'))) !== null) {
      positions.push(match.index);
    }

    if (positions.length === 0) {
      // start code not found yet; keep buffer
      return units;
    }

    for (let i = 0; i < positions.length; i++) {
      const start = positions[i];
      const next = positions[i + 1] ?? data.length;
      const slice = data.slice(start, next);
      // Drop leading start code bytes
      const offset =
        slice[0] === 0x00 && slice[1] === 0x00 && slice[2] === 0x01
          ? 3
          : slice[0] === 0x00 &&
              slice[1] === 0x00 &&
              slice[2] === 0x00 &&
              slice[3] === 0x01
            ? 4
            : 0;
      const nal = slice.slice(offset);
      if (nal.length > 0) {
        units.push(nal);
      }
    }

    // Remainder after last complete NAL
    const lastPos = positions[positions.length - 1];
    const lastStart =
      data[lastPos] === 0x00 && data[lastPos + 1] === 0x00 && data[lastPos + 2] === 0x01
        ? 3
        : 4;
    const lastNalStart = lastPos + lastStart;
    const lastNal = data.slice(lastNalStart);
    // keep partial last NAL
    this.leftover = lastNal;

    return units;
  }
}
