import {CommandExecutor} from '../utils/CommandExecutor';
import {Logger} from '../utils/Logger';
import {SimulatorManager} from './SimulatorManager';
import {Device, ScreenInfo} from './types';

export class AndroidEmulator extends SimulatorManager {
  private screenInfoCache: Map<string, ScreenInfo> = new Map();

  async isAvailable(): Promise<boolean> {
    try {
      await CommandExecutor.execute('adb', ['version']);
      return true;
    } catch {
      return false;
    }
  }

  async listDevices(): Promise<Device[]> {
    try {
      const {stdout} = await CommandExecutor.execute('adb', ['devices', '-l']);

      const devices: Device[] = [];
      const lines = stdout.split('\n').slice(1);

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('*')) {
          continue;
        }

        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) {
          continue;
        }

        const id = parts[0];
        const status = parts[1];

        let name = id;
        const modelMatch = trimmed.match(/model:(\S+)/);
        if (modelMatch) {
          name = modelMatch[1].replace(/_/g, ' ');
        }

        devices.push({
          id,
          name,
          platform: 'android',
          state: status === 'device' ? 'Booted' : 'Unknown',
        });
      }

      return devices;
    } catch (error) {
      Logger.error('Failed to list Android devices', error as Error);
      return [];
    }
  }

  async boot(_deviceId: string): Promise<void> {
    Logger.warn('Android emulator boot from extension is not implemented');
  }

  async shutdown(deviceId: string): Promise<void> {
    await CommandExecutor.execute('adb', ['-s', deviceId, 'emu', 'kill']);
    this.screenInfoCache.delete(deviceId);
    Logger.info(`Shutdown Android device: ${deviceId}`);
  }

  async takeScreenshot(deviceId: string): Promise<Buffer> {
    const buffer = await CommandExecutor.executeWithBinary('adb', [
      '-s',
      deviceId,
      'exec-out',
      'screencap',
      '-p',
    ]);

    return buffer;
  }

  async getScreenInfo(deviceId: string): Promise<ScreenInfo> {
    const cached = this.screenInfoCache.get(deviceId);
    if (cached) {
      return cached;
    }

    try {
      const {stdout} = await CommandExecutor.execute('adb', [
        '-s',
        deviceId,
        'shell',
        'wm',
        'size',
      ]);

      const match = stdout.match(/(\d+)x(\d+)/);
      if (match) {
        const info: ScreenInfo = {
          width: parseInt(match[1], 10),
          height: parseInt(match[2], 10),
        };
        this.screenInfoCache.set(deviceId, info);
        return info;
      }
    } catch (error) {
      Logger.warn(`Failed to get screen info for ${deviceId}`);
    }

    const defaultInfo: ScreenInfo = {width: 1080, height: 2400};
    return defaultInfo;
  }

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    const screenInfo = await this.getScreenInfo(deviceId);
    const actualX = Math.round(x * screenInfo.width);
    const actualY = Math.round(y * screenInfo.height);

    await CommandExecutor.execute('adb', [
      '-s',
      deviceId,
      'shell',
      'input',
      'tap',
      actualX.toString(),
      actualY.toString(),
    ]);
  }

  async swipe(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300
  ): Promise<void> {
    const screenInfo = await this.getScreenInfo(deviceId);
    const actualX1 = Math.round(x1 * screenInfo.width);
    const actualY1 = Math.round(y1 * screenInfo.height);
    const actualX2 = Math.round(x2 * screenInfo.width);
    const actualY2 = Math.round(y2 * screenInfo.height);

    await CommandExecutor.execute('adb', [
      '-s',
      deviceId,
      'shell',
      'input',
      'swipe',
      actualX1.toString(),
      actualY1.toString(),
      actualX2.toString(),
      actualY2.toString(),
      durationMs.toString(),
    ]);
  }

  async pressHome(deviceId: string): Promise<void> {
    await CommandExecutor.execute('adb', [
      '-s',
      deviceId,
      'shell',
      'input',
      'keyevent',
      'KEYCODE_HOME',
    ]);
  }

  async pressBack(deviceId: string): Promise<void> {
    await CommandExecutor.execute('adb', [
      '-s',
      deviceId,
      'shell',
      'input',
      'keyevent',
      'KEYCODE_BACK',
    ]);
  }

  async sendKey(
    deviceId: string,
    key: string,
    special?: boolean
  ): Promise<void> {
    Logger.info(`Sending key to Android: ${key}${special ? ' (special)' : ''}`);

    try {
      if (special) {
        // Handle special keys with keyevent
        const keyEventMap: {[key: string]: string} = {
          delete: 'KEYCODE_DEL',
          return: 'KEYCODE_ENTER',
          escape: 'KEYCODE_ESCAPE',
          tab: 'KEYCODE_TAB',
          space: 'KEYCODE_SPACE',
        };

        const keyEvent = keyEventMap[key.toLowerCase()];
        if (keyEvent) {
          await CommandExecutor.execute('adb', [
            '-s',
            deviceId,
            'shell',
            'input',
            'keyevent',
            keyEvent,
          ]);
        } else {
          Logger.warn(`Unknown special key: ${key}`);
          throw new Error(`Unknown special key: ${key}`);
        }
      } else {
        // Regular text input
        // Escape special characters for shell
        const escapedKey = key.replace(/[;&|`$(){}]/g, '');
        await CommandExecutor.execute('adb', [
          '-s',
          deviceId,
          'shell',
          'input',
          'text',
          escapedKey,
        ]);
      }
      Logger.debug(`Key sent to Android: ${key}`);
    } catch (error) {
      Logger.error('Failed to send key to Android', error as Error);
      throw error;
    }
  }

  dispose(): void {
    this.screenInfoCache.clear();
  }
}
