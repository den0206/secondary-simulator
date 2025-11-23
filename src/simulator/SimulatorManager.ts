import { Device, ScreenInfo } from './types';

export abstract class SimulatorManager {
  abstract listDevices(): Promise<Device[]>;
  abstract boot(deviceId: string): Promise<void>;
  abstract shutdown(deviceId: string): Promise<void>;
  abstract takeScreenshot(deviceId: string): Promise<Buffer>;
  abstract getScreenInfo(deviceId: string): Promise<ScreenInfo>;
  abstract tap(deviceId: string, x: number, y: number): Promise<void>;
  abstract swipe(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number
  ): Promise<void>;
  abstract pressHome(deviceId: string): Promise<void>;
  abstract pressBack(deviceId: string): Promise<void>;
  abstract sendKey(deviceId: string, key: string, special?: boolean): Promise<void>;
  abstract isAvailable(): Promise<boolean>;
}
