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
  | 'VOLUME_DOWN';

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
      'device_info',
      {deviceId}
    );
  }

  async listDevices(
    includeOffline: boolean = false
  ): Promise<ListDevicesResponse> {
    return this.jsonRpcClient.sendJsonRpcRequest<ListDevicesResponse>(
      'devices',
      {includeOffline}
    );
  }

  // 入力操作
  async tap(deviceId: string, x: number, y: number): Promise<void> {
    return this.jsonRpcClient.sendJsonRpcRequest('io_tap', {x, y, deviceId});
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
    return this.jsonRpcClient.sendJsonRpcRequest('io_gesture', {
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
      'io_text',
      {text, deviceId},
      timeoutMs
    );
  }

  async pressButton(deviceId: string, button: ButtonType): Promise<void> {
    return this.jsonRpcClient.sendJsonRpcRequest('io_button', {
      deviceId,
      button,
    });
  }
}
