import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { SimulatorManager } from './SimulatorManager';
import { Device, ScreenInfo } from './types';
import { CommandExecutor } from '../utils/CommandExecutor';
import { Logger } from '../utils/Logger';

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

interface SimctlOutput {
  devices: { [runtime: string]: SimctlDevice[] };
}

export class IOSSimulator extends SimulatorManager {
  private screenInfoCache: Map<string, ScreenInfo> = new Map();

  async isAvailable(): Promise<boolean> {
    try {
      await CommandExecutor.execute('xcrun', ['simctl', 'help']);
      return true;
    } catch {
      return false;
    }
  }

  async listDevices(): Promise<Device[]> {
    try {
      const { stdout } = await CommandExecutor.execute('xcrun', [
        'simctl',
        'list',
        'devices',
        '-j'
      ]);

      const data: SimctlOutput = JSON.parse(stdout);
      const devices: Device[] = [];

      for (const [runtime, deviceList] of Object.entries(data.devices)) {
        for (const device of deviceList) {
          if (!device.isAvailable) {
            continue;
          }

          const runtimeName = runtime
            .replace('com.apple.CoreSimulator.SimRuntime.', '')
            .replace(/-/g, ' ')
            .replace(/(\d+)/, ' $1');

          devices.push({
            id: device.udid,
            name: device.name,
            platform: 'ios',
            state: device.state === 'Booted' ? 'Booted' : 'Shutdown',
            runtime: runtimeName
          });
        }
      }

      return devices;
    } catch (error) {
      Logger.error('Failed to list iOS devices', error as Error);
      return [];
    }
  }

  async boot(deviceId: string): Promise<void> {
    await CommandExecutor.execute('xcrun', ['simctl', 'boot', deviceId]);
    Logger.info(`Booted iOS device: ${deviceId}`);
  }

  async shutdown(deviceId: string): Promise<void> {
    await CommandExecutor.execute('xcrun', ['simctl', 'shutdown', deviceId]);
    this.screenInfoCache.delete(deviceId);
    Logger.info(`Shutdown iOS device: ${deviceId}`);
  }

  async takeScreenshot(deviceId: string): Promise<Buffer> {
    const tmpFile = path.join(os.tmpdir(), `sim-${randomUUID()}.png`);

    try {
      await CommandExecutor.execute('xcrun', [
        'simctl',
        'io',
        deviceId,
        'screenshot',
        '--type=png',
        tmpFile
      ]);

      const buffer = await fs.readFile(tmpFile);
      return buffer;
    } finally {
      try {
        await fs.unlink(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async getScreenInfo(deviceId: string): Promise<ScreenInfo> {
    const cached = this.screenInfoCache.get(deviceId);
    if (cached) {
      return cached;
    }

    try {
      const { stdout } = await CommandExecutor.execute('xcrun', [
        'simctl',
        'io',
        deviceId,
        'enumerate'
      ]);

      const match = stdout.match(/Main Screen.*?(\d+)\s*x\s*(\d+)/i);
      if (match) {
        const info: ScreenInfo = {
          width: parseInt(match[1], 10),
          height: parseInt(match[2], 10)
        };
        this.screenInfoCache.set(deviceId, info);
        return info;
      }
    } catch (error) {
      Logger.warn(`Failed to get screen info for ${deviceId}`);
    }

    const defaultInfo: ScreenInfo = { width: 1170, height: 2532 };
    return defaultInfo;
  }

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    const screenInfo = await this.getScreenInfo(deviceId);
    const actualX = Math.round(x * screenInfo.width);
    const actualY = Math.round(y * screenInfo.height);

    await CommandExecutor.execute('xcrun', [
      'simctl',
      'io',
      deviceId,
      'tap',
      actualX.toString(),
      actualY.toString()
    ]);
  }

  async swipe(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    _durationMs?: number
  ): Promise<void> {
    const screenInfo = await this.getScreenInfo(deviceId);
    const actualX1 = Math.round(x1 * screenInfo.width);
    const actualY1 = Math.round(y1 * screenInfo.height);
    const actualX2 = Math.round(x2 * screenInfo.width);
    const actualY2 = Math.round(y2 * screenInfo.height);

    await CommandExecutor.execute('xcrun', [
      'simctl',
      'io',
      deviceId,
      'swipe',
      actualX1.toString(),
      actualY1.toString(),
      actualX2.toString(),
      actualY2.toString()
    ]);
  }

  async pressHome(deviceId: string): Promise<void> {
    await CommandExecutor.execute('xcrun', [
      'simctl',
      'io',
      deviceId,
      'home'
    ]);
  }

  async pressBack(_deviceId: string): Promise<void> {
    Logger.warn('iOS does not have a back button');
  }

  dispose(): void {
    this.screenInfoCache.clear();
  }
}
