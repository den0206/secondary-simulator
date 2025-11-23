export type Platform = 'ios' | 'android';
export type DeviceState = 'Booted' | 'Shutdown' | 'Unknown';

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  state: DeviceState;
  runtime?: string;
}

export interface ScreenInfo {
  width: number;
  height: number;
}
