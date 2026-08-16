export type Platform = 'ios' | 'android';
export type DeviceState = 'Booted' | 'Shutdown' | 'Unknown';
export type DeviceType = 'real' | 'emulator' | 'simulator';

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  state: DeviceState;
  runtime?: string;
  type?: DeviceType;
}

export interface ScreenInfo {
  width: number;
  height: number;
}
