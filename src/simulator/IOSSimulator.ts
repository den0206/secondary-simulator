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

  async tap(_deviceId: string, x: number, y: number): Promise<void> {
    Logger.info(`Tap at normalized (${x.toFixed(3)}, ${y.toFixed(3)})`);

    // iOS Simulator requires clicking on the Simulator window itself
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      // Use AppleScript to click at relative position within Simulator window
      const script = `
        tell application "Simulator" to activate
        delay 0.1
        tell application "System Events"
          tell process "Simulator"
            set frontWindow to front window
            set windowPosition to position of frontWindow
            set windowSize to size of frontWindow

            -- Calculate click position relative to window
            -- x and y are normalized (0-1)
            set clickX to (item 1 of windowPosition) + (${x} * (item 1 of windowSize))
            set clickY to (item 2 of windowPosition) + (${y} * (item 2 of windowSize))
          end tell
          click at {clickX, clickY}
        end tell
      `;

      await execFileAsync('osascript', ['-e', script]);
      Logger.debug('Tap sent via AppleScript');
    } catch (error) {
      Logger.error('Failed to send tap', error as Error);
    }
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
    Logger.info(`Pressing home on device: ${deviceId}`);

    // Use AppleScript to send Cmd+Shift+H (Home shortcut) to Simulator
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      const script = `
        tell application "Simulator" to activate
        delay 0.1
        tell application "System Events"
          keystroke "h" using {command down, shift down}
        end tell
      `;

      await execFileAsync('osascript', ['-e', script]);
      Logger.debug('Home button sent via AppleScript');
    } catch (error) {
      Logger.error('Failed to press home via AppleScript', error as Error);
    }
  }

  async pressBack(_deviceId: string): Promise<void> {
    Logger.warn('iOS does not have a back button');
  }

  dispose(): void {
    this.screenInfoCache.clear();
  }
}
