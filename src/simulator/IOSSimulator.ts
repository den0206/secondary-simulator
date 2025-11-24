import {CommandExecutor} from '../utils/CommandExecutor';
import {Logger} from '../utils/Logger';
import {SimulatorManager} from './SimulatorManager';
import {Device, ScreenInfo} from './types';

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

interface SimctlOutput {
  devices: {[runtime: string]: SimctlDevice[]};
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
      const {stdout} = await CommandExecutor.execute('xcrun', [
        'simctl',
        'list',
        'devices',
        '-j',
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
            runtime: runtimeName,
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
    try {
      // stdout に直接 PNG を吐かせ、ディスクを書かない
      const buffer = await CommandExecutor.executeWithBinary('xcrun', [
        'simctl',
        'io',
        deviceId,
        'screenshot',
        '--type=png',
        '-', // stdout
      ]);
      return buffer;
    } catch (error) {
      Logger.error('Failed to take screenshot', error as Error);
      throw error;
    }
  }

  /**
   * 旧実装で残留した sim-*.png を除去するためのヘルパー。
   * 現状は stdout 出力のみだが、将来の回 regresion に備えて残す。
   */
  async cleanLegacyTempFiles(): Promise<void> {
    const {TempCleaner} = await import('../utils/TempCleaner');
    await TempCleaner.cleanOnce();
  }

  async getScreenInfo(deviceId: string): Promise<ScreenInfo> {
    const cached = this.screenInfoCache.get(deviceId);
    if (cached) {
      return cached;
    }

    try {
      const {stdout} = await CommandExecutor.execute('xcrun', [
        'simctl',
        'io',
        deviceId,
        'enumerate',
      ]);

      const match = stdout.match(/Main Screen.*?(\d+)\s*x\s*(\d+)/i);
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

    const defaultInfo: ScreenInfo = {width: 1170, height: 2532};
    return defaultInfo;
  }

  async tap(_deviceId: string, x: number, y: number): Promise<void> {
    Logger.info(`Tap at normalized (${x.toFixed(3)}, ${y.toFixed(3)})`);

    const {execFile} = await import('child_process');
    const {promisify} = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      // Combined script: get window info, activate, click, and return to previous app
      const tapScript = `
        tell application "System Events"
          -- Get current frontmost app to return to later
          set frontApp to name of first application process whose frontmost is true

          tell process "Simulator"
            set frontWindow to front window
            set windowPosition to position of frontWindow
            set windowSize to size of frontWindow
            set winX to item 1 of windowPosition
            set winY to item 2 of windowPosition
            set winW to item 1 of windowSize
            set winH to item 2 of windowSize
          end tell
        end tell

        -- Calculate click position
        set clickX to winX + (${x} * winW)
        set clickY to winY + (${y} * winH)

        -- Activate Simulator and click
        tell application "Simulator" to activate
        delay 0.05

        tell application "System Events"
          click at {clickX, clickY}
        end tell

        delay 0.05

        -- Return to previous app
        tell application frontApp to activate
      `;

      await execFileAsync('osascript', ['-e', tapScript]);
      Logger.debug('Tap sent via AppleScript with app switching');
    } catch (error) {
      const err = error as Error;
      if (err.message && err.message.includes('-25211')) {
        Logger.error(
          'Accessibility permission required. Please grant permission in System Settings > Privacy & Security > Accessibility for Terminal or VS Code.',
          err
        );
      } else {
        Logger.error('Failed to send tap', err);
      }
      throw error;
    }
  }

  async swipe(
    _deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300
  ): Promise<void> {
    Logger.info(
      `Swipe from (${x1.toFixed(3)}, ${y1.toFixed(3)}) to (${x2.toFixed(
        3
      )}, ${y2.toFixed(3)}) duration=${durationMs ?? 'default'}ms`
    );

    const {execFile} = await import('child_process');
    const {promisify} = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      const duration = Number.isFinite(durationMs) && durationMs > 0
        ? Math.max(50, Math.min(durationMs, 3000))
        : 300;
      const steps = Math.max(10, Math.min(60, Math.round(duration / 16)));
      const stepDelay = duration / steps / 1000;

      // Combined script: get window info, activate, swipe using CGEvent, and return to previous app
      const swipeScript = `
        ObjC.import('Cocoa');

        // Get current frontmost app
        var sysEvents = Application('System Events');
        var frontApp = sysEvents.processes.whose({frontmost: true})[0].name();

        // Get Simulator window info
        var simProcess = sysEvents.processes['Simulator'];
        var frontWindow = simProcess.windows[0];
        var pos = frontWindow.position();
        var size = frontWindow.size();
        var winX = pos[0];
        var winY = pos[1];
        var winW = size[0];
        var winH = size[1];

        // Calculate swipe positions
        var startX = winX + ${x1} * winW;
        var startY = winY + ${y1} * winH;
        var endX = winX + ${x2} * winW;
        var endY = winY + ${y2} * winH;

        // Activate Simulator
        var sim = Application('Simulator');
        sim.activate();
        delay(0.05);

        // Perform swipe using CGEvent
        var steps = ${steps};
        var stepDelay = ${stepDelay};

        // Mouse down
        var mouseDown = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, $.CGPointMake(startX, startY), $.kCGMouseButtonLeft);
        $.CGEventPost($.kCGHIDEventTap, mouseDown);

        for (var i = 1; i <= steps; i++) {
          var t = i / steps;
          var currentX = startX + (endX - startX) * t;
          var currentY = startY + (endY - startY) * t;
          var dragEvent = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDragged, $.CGPointMake(currentX, currentY), $.kCGMouseButtonLeft);
          $.CGEventPost($.kCGHIDEventTap, dragEvent);
          delay(stepDelay);
        }

        // Mouse up
        var mouseUp = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, $.CGPointMake(endX, endY), $.kCGMouseButtonLeft);
        $.CGEventPost($.kCGHIDEventTap, mouseUp);

        delay(0.05);

        // Return to previous app
        var prevApp = Application(frontApp);
        prevApp.activate();
      `;

      await execFileAsync('osascript', ['-l', 'JavaScript', '-e', swipeScript]);
      Logger.debug('Swipe sent via JXA with app switching');
    } catch (error) {
      const err = error as Error;
      if (err.message && err.message.includes('-25211')) {
        Logger.error(
          'Accessibility permission required. Please grant permission in System Settings > Privacy & Security > Accessibility for Terminal or VS Code.',
          err
        );
      } else {
        Logger.error('Failed to send swipe', err);
      }
      throw error;
    }
  }

  async pressHome(_deviceId: string): Promise<void> {
    Logger.info('Pressing home button');

    const {execFile} = await import('child_process');
    const {promisify} = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      // Use AppleScript to send Cmd+Shift+H (Home shortcut)
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
      Logger.error('Failed to press home', error as Error);
      throw error;
    }
  }

  async pressBack(_deviceId: string): Promise<void> {
    Logger.warn('iOS does not have a back button');
  }

  async sendKey(
    _deviceId: string,
    key: string,
    special?: boolean
  ): Promise<void> {
    Logger.info(`Sending key: ${key}${special ? ' (special)' : ''}`);

    const {execFile} = await import('child_process');
    const {promisify} = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      let script: string;

      if (special) {
        // Handle special keys with key code
        const keyCodeMap: {[key: string]: number} = {
          delete: 51, // Backspace
          return: 36, // Enter
          escape: 53, // Escape
          tab: 48, // Tab
          space: 49, // Space
        };

        const keyCode = keyCodeMap[key.toLowerCase()];
        if (keyCode !== undefined) {
          script = `
            tell application "Simulator" to activate
            delay 0.05
            tell application "System Events"
              key code ${keyCode}
            end tell
          `;
        } else {
          Logger.warn(`Unknown special key: ${key}`);
          throw new Error(`Unknown special key: ${key}`);
        }
      } else {
        // Regular character
        const escapedKey = key
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"');

        script = `
          tell application "Simulator" to activate
          delay 0.05
          tell application "System Events"
            keystroke "${escapedKey}"
          end tell
        `;
      }

      await execFileAsync('osascript', ['-e', script]);
      Logger.debug(`Key sent via AppleScript: ${key}`);
    } catch (error) {
      Logger.error('Failed to send key', error as Error);
      throw error;
    }
  }

  dispose(): void {
    this.screenInfoCache.clear();
  }
}
