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
    Logger.info(`Tap at normalized (${x.toFixed(3)}, ${y.toFixed(3)})`);

    // Get screen info to convert normalized coordinates to pixel coordinates
    const screenInfo = await this.getScreenInfo(deviceId);
    const pixelX = Math.round(x * screenInfo.width);
    const pixelY = Math.round(y * screenInfo.height);

    Logger.debug(`Tap at pixel coordinates: (${pixelX}, ${pixelY})`);

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      // Use AppleScript to click at the calculated position within Simulator window
      // First, get the Simulator window bounds - find the device window by name and size
      const getWindowScript = `
        tell application "Simulator" to activate
        delay 0.15
        tell application "System Events"
          tell process "Simulator"
            -- Try to find the main device window by name and size
            set deviceWindow to missing value
            set allWindows to every window

            -- First, try to find by name (iPhone, iPad, etc.)
            repeat with aWindow in allWindows
              try
                set windowName to name of aWindow
                if windowName contains "iPhone" or windowName contains "iPad" or windowName contains "iPod" then
                  set windowSize to size of aWindow
                  set windowWidth to item 1 of windowSize
                  set windowHeight to item 2 of windowSize
                  -- Make sure it's a reasonable size (not a toolbar or menu)
                  if windowWidth > 200 and windowHeight > 200 then
                    set deviceWindow to aWindow
                    exit repeat
                  end if
                end if
              end try
            end repeat

            -- If not found by name, find the largest window (usually the device window)
            if deviceWindow is missing value then
              set largestWindow to missing value
              set largestArea to 0
              repeat with aWindow in allWindows
                try
                  set windowSize to size of aWindow
                  set windowWidth to item 1 of windowSize
                  set windowHeight to item 2 of windowSize
                  set windowArea to windowWidth * windowHeight
                  -- Only consider windows that are reasonably large
                  if windowArea > largestArea and windowWidth > 200 and windowHeight > 200 then
                    set largestWindow to aWindow
                    set largestArea to windowArea
                  end if
                end try
              end repeat
              if largestWindow is not missing value then
                set deviceWindow to largestWindow
              end if
            end if

            -- Last resort: use front window if it's large enough
            if deviceWindow is missing value then
              try
                set frontWindow to front window
                set windowSize to size of frontWindow
                set windowWidth to item 1 of windowSize
                set windowHeight to item 2 of windowSize
                if windowWidth > 200 and windowHeight > 200 then
                  set deviceWindow to frontWindow
                end if
              end try
            end if

            if deviceWindow is not missing value then
              set windowPosition to position of deviceWindow
              set windowSize to size of deviceWindow
              set posX to item 1 of windowPosition as string
              set posY to item 2 of windowPosition as string
              set sizeW to item 1 of windowSize as string
              set sizeH to item 2 of windowSize as string
              return posX & "," & posY & "," & sizeW & "," & sizeH
            else
              error "Could not find Simulator device window"
            end if
          end tell
        end tell
      `;

      const { stdout } = await execFileAsync('osascript', ['-e', getWindowScript]);
      // Parse the output - handle cases where there might be extra commas or spaces
      const values = stdout.trim().split(',').filter(v => v.trim() !== '').map(v => parseInt(v.trim(), 10));

      if (values.length < 4) {
        throw new Error(`Invalid window info from AppleScript: ${stdout.trim()}`);
      }

      const [winX, winY, winW, winH] = values;

      Logger.debug(`Window: pos(${winX}, ${winY}), size(${winW}, ${winH})`);

      // Validate window size
      if (isNaN(winW) || isNaN(winH) || winW <= 0 || winH <= 0) {
        throw new Error(`Invalid window size: ${winW}x${winH} (raw output: ${stdout.trim()})`);
      }

      // Calculate click position: Simulator window contains device screen
      // The device screen is typically centered in the window
      // Calculate scale factor to map device pixels to window pixels
      const scaleX = winW / screenInfo.width;
      const scaleY = winH / screenInfo.height;
      const scale = Math.min(scaleX, scaleY); // Use uniform scaling to maintain aspect ratio

      // Calculate the actual screen area in the window (centered)
      const scaledWidth = screenInfo.width * scale;
      const scaledHeight = screenInfo.height * scale;
      const screenOffsetX = (winW - scaledWidth) / 2;
      const screenOffsetY = (winH - scaledHeight) / 2;

      // Map device pixel coordinates to window coordinates
      const clickX = Math.round(winX + screenOffsetX + (pixelX * scale));
      const clickY = Math.round(winY + screenOffsetY + (pixelY * scale));

      Logger.debug(`Calculated click position: (${clickX}, ${clickY})`);

      // Perform the click
      const clickScript = `
        tell application "System Events"
          click at {${clickX}, ${clickY}}
        end tell
      `;

      await execFileAsync('osascript', ['-e', clickScript]);
      Logger.debug('Tap sent via AppleScript');
    } catch (error) {
      Logger.error('Failed to send tap', error as Error);
      throw error;
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
    Logger.info(`Swipe from (${x1.toFixed(3)}, ${y1.toFixed(3)}) to (${x2.toFixed(3)}, ${y2.toFixed(3)})`);

    // Get screen info to convert normalized coordinates to pixel coordinates
    const screenInfo = await this.getScreenInfo(deviceId);
    const pixelX1 = Math.round(x1 * screenInfo.width);
    const pixelY1 = Math.round(y1 * screenInfo.height);
    const pixelX2 = Math.round(x2 * screenInfo.width);
    const pixelY2 = Math.round(y2 * screenInfo.height);

    Logger.debug(`Swipe at pixel coordinates: (${pixelX1}, ${pixelY1}) -> (${pixelX2}, ${pixelY2})`);

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      // First, get window position and size - use the same improved method as tap
      const getWindowScript = `
        tell application "Simulator" to activate
        delay 0.15
        tell application "System Events"
          tell process "Simulator"
            -- Try to find the main device window by name and size
            set deviceWindow to missing value
            set allWindows to every window

            -- First, try to find by name (iPhone, iPad, etc.)
            repeat with aWindow in allWindows
              try
                set windowName to name of aWindow
                if windowName contains "iPhone" or windowName contains "iPad" or windowName contains "iPod" then
                  set windowSize to size of aWindow
                  set windowWidth to item 1 of windowSize
                  set windowHeight to item 2 of windowSize
                  -- Make sure it's a reasonable size (not a toolbar or menu)
                  if windowWidth > 200 and windowHeight > 200 then
                    set deviceWindow to aWindow
                    exit repeat
                  end if
                end if
              end try
            end repeat

            -- If not found by name, find the largest window
            if deviceWindow is missing value then
              set largestWindow to missing value
              set largestArea to 0
              repeat with aWindow in allWindows
                try
                  set windowSize to size of aWindow
                  set windowWidth to item 1 of windowSize
                  set windowHeight to item 2 of windowSize
                  set windowArea to windowWidth * windowHeight
                  -- Only consider windows that are reasonably large
                  if windowArea > largestArea and windowWidth > 200 and windowHeight > 200 then
                    set largestWindow to aWindow
                    set largestArea to windowArea
                  end if
                end try
              end repeat
              if largestWindow is not missing value then
                set deviceWindow to largestWindow
              end if
            end if

            -- Last resort: use front window if it's large enough
            if deviceWindow is missing value then
              try
                set frontWindow to front window
                set windowSize to size of frontWindow
                set windowWidth to item 1 of windowSize
                set windowHeight to item 2 of windowSize
                if windowWidth > 200 and windowHeight > 200 then
                  set deviceWindow to frontWindow
                end if
              end try
            end if

            if deviceWindow is not missing value then
              set windowPosition to position of deviceWindow
              set windowSize to size of deviceWindow
              set posX to item 1 of windowPosition as string
              set posY to item 2 of windowPosition as string
              set sizeW to item 1 of windowSize as string
              set sizeH to item 2 of windowSize as string
              return posX & "," & posY & "," & sizeW & "," & sizeH
            else
              error "Could not find Simulator device window"
            end if
          end tell
        end tell
      `;

      const { stdout } = await execFileAsync('osascript', ['-e', getWindowScript]);
      // Parse the output - handle cases where there might be extra commas or spaces
      const values = stdout.trim().split(',').filter(v => v.trim() !== '').map(v => parseInt(v.trim(), 10));

      if (values.length < 4) {
        throw new Error(`Invalid window info from AppleScript: ${stdout.trim()}`);
      }

      const [winX, winY, winW, winH] = values;

      Logger.debug(`Window: pos(${winX}, ${winY}), size(${winW}, ${winH})`);

      // Validate window size
      if (isNaN(winW) || isNaN(winH) || winW <= 0 || winH <= 0) {
        throw new Error(`Invalid window size: ${winW}x${winH} (raw output: ${stdout.trim()})`);
      }

      // Calculate screen area bounds (similar to tap)
      const scaleX = winW / screenInfo.width;
      const scaleY = winH / screenInfo.height;
      const scale = Math.min(scaleX, scaleY); // Use uniform scaling

      // Calculate the actual screen area in the window (centered)
      const scaledWidth = screenInfo.width * scale;
      const scaledHeight = screenInfo.height * scale;
      const screenOffsetX = (winW - scaledWidth) / 2;
      const screenOffsetY = (winH - scaledHeight) / 2;

      const startX = Math.round(winX + screenOffsetX + (pixelX1 * scale));
      const startY = Math.round(winY + screenOffsetY + (pixelY1 * scale));
      const endX = Math.round(winX + screenOffsetX + (pixelX2 * scale));
      const endY = Math.round(winY + screenOffsetY + (pixelY2 * scale));

      Logger.debug(`Swipe coords: (${startX}, ${startY}) -> (${endX}, ${endY})`);

      // Perform drag using JXA (JavaScript for Automation) for smoother drag
      const dragScript = `
        ObjC.import('Cocoa');

        var startX = ${startX};
        var startY = ${startY};
        var endX = ${endX};
        var endY = ${endY};

        // Mouse down
        var mouseDown = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, $.CGPointMake(startX, startY), $.kCGMouseButtonLeft);
        $.CGEventPost($.kCGHIDEventTap, mouseDown);

        // Drag in steps for smooth movement
        var steps = 15;
        for (var i = 1; i <= steps; i++) {
          var t = i / steps;
          var currentX = startX + (endX - startX) * t;
          var currentY = startY + (endY - startY) * t;
          var dragEvent = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDragged, $.CGPointMake(currentX, currentY), $.kCGMouseButtonLeft);
          $.CGEventPost($.kCGHIDEventTap, dragEvent);
          delay(0.01);
        }

        // Mouse up
        var mouseUp = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, $.CGPointMake(endX, endY), $.kCGMouseButtonLeft);
        $.CGEventPost($.kCGHIDEventTap, mouseUp);
      `;

      await execFileAsync('osascript', ['-l', 'JavaScript', '-e', dragScript]);
      Logger.debug('Swipe sent via JXA');
    } catch (error) {
      Logger.error('Failed to send swipe', error as Error);
      throw error;
    }
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

  async sendKey(deviceId: string, key: string, special?: boolean): Promise<void> {
    Logger.info(`Sending key: ${key}${special ? ' (special)' : ''}`);

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      let script: string;

      if (special) {
        // Handle special keys with key code
        const keyCodeMap: { [key: string]: number } = {
          'delete': 51,    // Backspace
          'return': 36,    // Enter
          'escape': 53,    // Escape
          'tab': 48,      // Tab
          'space': 49,     // Space
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
        // Regular character - escape special characters for AppleScript
        const escapedKey = key
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\$/g, '\\$')
          .replace(/`/g, '\\`');

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
      Logger.error('Failed to send key via AppleScript', error as Error);
      throw error;
    }
  }

  dispose(): void {
    this.screenInfoCache.clear();
  }
}
