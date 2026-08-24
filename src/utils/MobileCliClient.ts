import {JsonRpcClient} from './JsonRpcClient';

/**
 * mobilecliのデバイス操作API
 */
export type ButtonType =
  | 'HOME'
  | 'BACK'
  | 'APP_SWITCH'
  | 'POWER'
  | 'VOLUME_UP'
  | 'VOLUME_DOWN'
  | 'DPAD_UP'
  | 'DPAD_DOWN'
  | 'DPAD_LEFT'
  | 'DPAD_RIGHT';

export interface DeviceDescriptor {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  type: 'real' | 'emulator' | 'simulator';
  version?: string;
  state?: 'online' | 'offline';
}

export interface ListDevicesResponse {
  devices: DeviceDescriptor[];
}

export interface DeviceInfoResponse {
  device: {
    id: string;
    name: string;
    platform: string;
    type: string;
    screenSize: {
      width: number;
      height: number;
      scale: number;
    };
  };
}

/**
 * mobilecli JSON-RPC クライアント
 * デバイス操作を統一されたAPIで実行
 */
export class MobileCliClient {
  constructor(private readonly jsonRpcClient: JsonRpcClient) {}

  // デバイス管理
  async getDeviceInfo(deviceId: string): Promise<DeviceInfoResponse> {
    return this.jsonRpcClient.sendJsonRpcRequest<DeviceInfoResponse>(
      'device.info',
      {deviceId}
    );
  }

  async listDevices(
    includeOffline: boolean = false
  ): Promise<ListDevicesResponse> {
    return this.jsonRpcClient.sendJsonRpcRequest<ListDevicesResponse>(
      'devices.list',
      {includeOffline}
    );
  }

  /**
   * 画面を 1 枚取る。応答の形は版によって違うので、そのまま返して
   * decodeScreenshotResult に解釈させる。
   */
  async screenshot(
    deviceId: string,
    format: 'png' | 'jpeg' = 'png',
    timeoutMs = 15000
  ): Promise<unknown> {
    return this.jsonRpcClient.sendJsonRpcRequest<unknown>(
      'device.screenshot',
      {deviceId, format},
      timeoutMs
    );
  }

  /**
   * 停止中のデバイスを起動する。シミュレータの起動は数十秒かかることがあるので
   * 既定のタイムアウトを長めに取る。
   */
  async boot(deviceId: string, timeoutMs = 120_000): Promise<void> {
    return this.jsonRpcClient.sendJsonRpcRequest(
      'device.boot',
      {deviceId},
      timeoutMs
    );
  }

  /**
   * 画面録画を開始する。
   *
   * `output` は**ホスト側の保存先パス**で、mobilecli が自分で書く。
   * 拡張が一時ファイルを抱えないので「永続ストレージを持たない」方針を崩さない
   * （保存先はスクリーンショットと同じくユーザーが選ぶ）。
   *
   * **録画が始まったと確認できるまで応答が返らない**（mobilecli 1.0.x）。
   * iOS 実機は ReplayKit のブロードキャストピッカーを利用者が押すまで待つので、
   * 待ちは mobilecli 側の上限（60 秒）より長く取る。**先に諦めると、拡張は
   * 「開始できなかった」と言いながら端末では録画が始まる**（追跡していないので
   * 停止も 10 分の上限も効かない）。
   */
  async startScreenRecord(
    deviceId: string,
    output: string,
    timeoutMs = 90_000
  ): Promise<void> {
    return this.jsonRpcClient.sendJsonRpcRequest(
      'device.screenrecord',
      {deviceId, output},
      timeoutMs
    );
  }

  /**
   * 録画を止めて書き出させる。端末から引き上げて変換するぶん時間がかかる
   * （バイナリに "Pulling recording from device..." がある）ので待ちを長く取る。
   */
  async stopScreenRecord(deviceId: string, timeoutMs = 180_000): Promise<void> {
    return this.jsonRpcClient.sendJsonRpcRequest(
      'device.screenrecord.stop',
      {deviceId},
      timeoutMs
    );
  }

  /** ディープリンク／URL をデバイスで開く（`xcrun simctl openurl` 相当）。 */
  async openUrl(
    deviceId: string,
    url: string,
    timeoutMs = 30_000
  ): Promise<void> {
    return this.jsonRpcClient.sendJsonRpcRequest(
      'device.url',
      {deviceId, url},
      timeoutMs
    );
  }

  // 入力操作
  async tap(deviceId: string, x: number, y: number): Promise<void> {
    return this.jsonRpcClient.sendJsonRpcRequest('device.io.tap', {
      x,
      y,
      deviceId,
    });
  }

  async gesture(
    deviceId: string,
    actions: Array<{
      type: string;
      duration?: number;
      x?: number;
      y?: number;
      button?: number;
    }>
  ): Promise<void> {
    return this.jsonRpcClient.sendJsonRpcRequest('device.io.gesture', {
      deviceId,
      actions,
    });
  }

  async inputText(
    deviceId: string,
    text: string,
    timeoutMs?: number
  ): Promise<void> {
    return this.jsonRpcClient.sendJsonRpcRequest(
      'device.io.text',
      {text, deviceId},
      timeoutMs
    );
  }

  async pressButton(deviceId: string, button: ButtonType): Promise<void> {
    return this.jsonRpcClient.sendJsonRpcRequest('device.io.button', {
      deviceId,
      button,
    });
  }
}
