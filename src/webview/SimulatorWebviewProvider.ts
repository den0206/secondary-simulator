import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import {ScreenshotCapture} from '../capture/ScreenshotCapture';
import {AndroidEmulator} from '../simulator/AndroidEmulator';
import {IOSSimulator} from '../simulator/IOSSimulator';
import {SimulatorManager} from '../simulator/SimulatorManager';
import {Device, Platform} from '../simulator/types';
import {Logger} from '../utils/Logger';

export class SimulatorWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'simulatorView';

  private view?: vscode.WebviewView;
  private extensionUri: vscode.Uri;
  private iosSimulator: IOSSimulator;
  private androidEmulator: AndroidEmulator;
  private currentManager: SimulatorManager | null = null;
  private currentCapture: ScreenshotCapture | null = null;
  private currentDeviceId: string | null = null;
  private currentPlatform: Platform = 'ios';
  private devices: Device[] = [];
  private currentWidth: number = 250;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    this.iosSimulator = new IOSSimulator();
    this.androidEmulator = new AndroidEmulator();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      this.handleMessage.bind(this),
      undefined,
      []
    );

    webviewView.onDidDispose(() => {
      this.stopCapture();
    });

    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        this.stopCapture();
      }
    });

    this.refreshDevices();
  }

  private async handleMessage(message: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    Logger.debug(`Received message: ${message.type}`);

    try {
      switch (message.type) {
        case 'init':
          await this.refreshDevices();
          break;

        case 'platformChange':
          this.currentPlatform = message.platform as Platform;
          await this.refreshDevices();
          break;

        case 'deviceChange':
          await this.selectDevice(message.deviceId as string);
          break;

        case 'tap':
          Logger.info(`Tap received: x=${message.x}, y=${message.y}`);
          await this.handleTap(message.x as number, message.y as number);
          break;

        case 'swipe':
          Logger.info(
            `Swipe received: (${message.x1}, ${message.y1}) -> (${message.x2}, ${message.y2})`
          );
          await this.handleSwipe(
            message.x1 as number,
            message.y1 as number,
            message.x2 as number,
            message.y2 as number
          );
          break;

        case 'keypress':
          Logger.info(
            `Key pressed: ${message.key}${message.special ? ' (special)' : ''}`
          );
          await this.handleKeypress(
            message.key as string,
            message.special as boolean
          );
          break;

        case 'home':
          Logger.info('Home button pressed');
          await this.pressHome();
          break;

        case 'back':
          Logger.info('Back button pressed');
          await this.pressBack();
          break;

        case 'refreshDevices':
          Logger.info('Refresh devices requested');
          await this.refreshDevices();
          break;

        case 'saveScreenshot':
          await this.saveScreenshot();
          break;

        case 'disconnect':
          Logger.info('Disconnect requested');
          this.disconnect();
          break;

        case 'resize':
          this.currentWidth = message.width as number;
          if (this.currentCapture) {
            this.currentCapture.setMaxWidth(this.currentWidth);
          }
          break;
      }
    } catch (error) {
      Logger.error('Failed to handle message', error as Error);
      this.sendError((error as Error).message);
    }
  }

  async refreshDevices(): Promise<void> {
    const manager =
      this.currentPlatform === 'ios' ? this.iosSimulator : this.androidEmulator;

    const isAvailable = await manager.isAvailable();
    if (!isAvailable) {
      const platform = this.currentPlatform === 'ios' ? 'Xcode' : 'Android SDK';
      this.sendError(`${platform} is not installed or not in PATH`);
      this.devices = [];
      this.postMessage({type: 'devices', devices: []});
      return;
    }

    this.devices = await manager.listDevices();
    this.postMessage({type: 'devices', devices: this.devices});
    this.postMessage({
      type: 'status',
      text: `${this.devices.length} devices found`,
    });
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (!deviceId) {
      this.stopCapture();
      this.currentDeviceId = null;
      return;
    }

    const device = this.devices.find((d) => d.id === deviceId);
    if (!device) {
      this.sendError('Device not found');
      return;
    }

    if (device.state !== 'Booted') {
      this.sendError(
        'Device is not running. Please start the simulator first.'
      );
      return;
    }

    this.stopCapture();

    this.currentDeviceId = deviceId;
    this.currentManager =
      device.platform === 'ios' ? this.iosSimulator : this.androidEmulator;

    this.currentCapture = new ScreenshotCapture(
      this.currentManager,
      this.currentWidth
    );
    this.currentCapture.setDevice(deviceId);

    this.currentCapture.onFrame((frame, stats) => {
      this.postMessage({
        type: 'frame',
        data: frame,
      });
      this.postMessage({
        type: 'stats',
        fps: stats.fps,
        latency: stats.latency,
      });
    });

    try {
      await this.currentCapture.start();
      this.postMessage({type: 'status', text: 'Capturing'});
      Logger.info(`Started capturing device: ${device.name}`);
    } catch (error) {
      Logger.error('Failed to start capture', error as Error);
      this.sendError('Failed to start capture');
    }
  }

  private async handleTap(x: number, y: number): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot tap: no device selected');
      return;
    }

    try {
      await this.currentManager.tap(this.currentDeviceId, x, y);
    } catch (error) {
      Logger.error('Failed to send tap', error as Error);
    }
  }

  private async handleSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot swipe: no device selected');
      return;
    }

    try {
      await this.currentManager.swipe(this.currentDeviceId, x1, y1, x2, y2);
    } catch (error) {
      Logger.error('Failed to send swipe', error as Error);
    }
  }

  private async handleKeypress(key: string, special?: boolean): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot send key: no device selected');
      return;
    }

    try {
      await this.currentManager.sendKey(this.currentDeviceId, key, special);
    } catch (error) {
      Logger.error('Failed to send key', error as Error);
    }
  }

  private async pressHome(): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot press home: no device selected');
      return;
    }

    try {
      Logger.debug(`Pressing home on device: ${this.currentDeviceId}`);
      await this.currentManager.pressHome(this.currentDeviceId);
      Logger.debug('Home pressed successfully');
    } catch (error) {
      Logger.error('Failed to press home', error as Error);
    }
  }

  private async pressBack(): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot press back: no device selected');
      return;
    }

    try {
      await this.currentManager.pressBack(this.currentDeviceId);
    } catch (error) {
      Logger.error('Failed to press back', error as Error);
    }
  }

  private async saveScreenshot(): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      vscode.window.showWarningMessage('No device selected');
      return;
    }

    try {
      const screenshot = await this.currentManager.takeScreenshot(
        this.currentDeviceId
      );

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`screenshot-${Date.now()}.png`),
        filters: {
          'PNG Images': ['png'],
        },
      });

      if (uri) {
        await fs.writeFile(uri.fsPath, screenshot);
        vscode.window.showInformationMessage(
          `Screenshot saved to ${uri.fsPath}`
        );
      }
    } catch (error) {
      Logger.error('Failed to save screenshot', error as Error);
      vscode.window.showErrorMessage('Failed to save screenshot');
    }
  }

  private stopCapture(): void {
    if (this.currentCapture) {
      this.currentCapture.dispose();
      this.currentCapture = null;
    }
    this.postMessage({type: 'status', text: 'Idle'});
  }

  private disconnect(): void {
    this.stopCapture();
    this.currentDeviceId = null;
    this.currentManager = null;
    this.postMessage({type: 'disconnected'});
    this.postMessage({type: 'status', text: 'Disconnected'});
    Logger.info('Device disconnected');
  }

  private postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private sendError(text: string): void {
    this.postMessage({type: 'error', text});
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      margin: 0;
      padding: 8px;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .device-selector {
      display: flex;
      gap: 4px;
      margin-bottom: 8px;
    }

    .device-selector select {
      flex: 1;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      font-size: 12px;
    }

    .simulator-container {
      position: relative;
      width: 100%;
      background: #000;
      border-radius: 8px;
      overflow: hidden;
      min-height: 200px;
    }

    #simulator-screen {
      width: 100%;
      height: auto;
      display: block;
      cursor: pointer;
    }

    .overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.8);
      color: #fff;
      font-size: 12px;
      text-align: center;
      padding: 20px;
    }

    .overlay.hidden {
      display: none;
    }

    .controls {
      display: flex;
      justify-content: center;
      gap: 4px;
      margin-top: 8px;
      flex-wrap: wrap;
    }

    .control-btn {
      padding: 6px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .control-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .control-btn:active {
      transform: scale(0.95);
    }

    .status-bar {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border);
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <div class="device-selector">
    <select id="platform">
      <option value="ios">iOS</option>
      <option value="android">Android</option>
    </select>
    <select id="device">
      <option value="">Select Device...</option>
    </select>
  </div>

  <div class="simulator-container">
    <img id="simulator-screen" src="" alt="Simulator Screen" style="display: none;" />
    <div class="overlay" id="overlay">
      <span>Select a device to start</span>
    </div>
  </div>

  <div class="controls">
    <button class="control-btn" id="btn-home" title="Home">Home</button>
    <button class="control-btn" id="btn-back" title="Back">Back</button>
    <button class="control-btn" id="btn-screenshot" title="Save Screenshot">Save</button>
    <button class="control-btn" id="btn-refresh" title="Refresh Devices">Refresh</button>
    <button class="control-btn" id="btn-disconnect" title="Disconnect">Disconnect</button>
  </div>

  <div class="status-bar">
    <span id="fps">-- FPS</span>
    <span id="status">Idle</span>
    <span id="latency">-- ms</span>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const screen = document.getElementById('simulator-screen');
    const overlay = document.getElementById('overlay');
    const platformSelect = document.getElementById('platform');
    const deviceSelect = document.getElementById('device');

    // Touch/Mouse event handling for tap and swipe
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    const SWIPE_THRESHOLD = 30; // minimum pixels for swipe
    const TAP_THRESHOLD = 10; // maximum pixels for tap

    screen.addEventListener('mousedown', (e) => {
      isDragging = true;
      const rect = screen.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      startTime = Date.now();
      e.preventDefault();
    });

    screen.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      e.preventDefault();
    });

    screen.addEventListener('mouseup', (e) => {
      if (!isDragging) return;
      isDragging = false;

      const rect = screen.getBoundingClientRect();
      const endX = e.clientX - rect.left;
      const endY = e.clientY - rect.top;
      const duration = Date.now() - startTime;

      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance < TAP_THRESHOLD) {
        // It's a tap
        const x = endX / rect.width;
        const y = endY / rect.height;
        vscode.postMessage({ type: 'tap', x, y });
      } else if (distance >= SWIPE_THRESHOLD) {
        // It's a swipe
        const x1 = startX / rect.width;
        const y1 = startY / rect.height;
        const x2 = endX / rect.width;
        const y2 = endY / rect.height;
        vscode.postMessage({ type: 'swipe', x1, y1, x2, y2, duration });
      }
    });

    screen.addEventListener('mouseleave', () => {
      isDragging = false;
    });

    // Touch events for mobile/trackpad
    screen.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        const touch = e.touches[0];
        const rect = screen.getBoundingClientRect();
        startX = touch.clientX - rect.left;
        startY = touch.clientY - rect.top;
        startTime = Date.now();
        isDragging = true;
      }
      e.preventDefault();
    }, { passive: false });

    screen.addEventListener('touchend', (e) => {
      if (!isDragging || e.changedTouches.length !== 1) return;
      isDragging = false;

      const touch = e.changedTouches[0];
      const rect = screen.getBoundingClientRect();
      const endX = touch.clientX - rect.left;
      const endY = touch.clientY - rect.top;
      const duration = Date.now() - startTime;

      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance < TAP_THRESHOLD) {
        const x = endX / rect.width;
        const y = endY / rect.height;
        vscode.postMessage({ type: 'tap', x, y });
      } else if (distance >= SWIPE_THRESHOLD) {
        const x1 = startX / rect.width;
        const y1 = startY / rect.height;
        const x2 = endX / rect.width;
        const y2 = endY / rect.height;
        vscode.postMessage({ type: 'swipe', x1, y1, x2, y2, duration });
      }
      e.preventDefault();
    }, { passive: false });

    // Keyboard input handling
    document.addEventListener('keydown', (e) => {
      // Only capture when screen is visible and focused
      if (screen.style.display === 'none') return;

      // Ignore modifier-only keys and some special keys
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) return;

      // Handle special keys
      if (e.key === 'Backspace') {
        vscode.postMessage({ type: 'keypress', key: 'delete', special: true });
        e.preventDefault();
        return;
      }

      if (e.key === 'Enter') {
        vscode.postMessage({ type: 'keypress', key: 'return', special: true });
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        vscode.postMessage({ type: 'keypress', key: 'escape', special: true });
        e.preventDefault();
        return;
      }

      // For regular characters
      if (e.key.length === 1) {
        vscode.postMessage({ type: 'keypress', key: e.key });
        e.preventDefault();
      }
    });

    platformSelect.addEventListener('change', () => {
      vscode.postMessage({
        type: 'platformChange',
        platform: platformSelect.value
      });
    });

    deviceSelect.addEventListener('change', () => {
      vscode.postMessage({
        type: 'deviceChange',
        deviceId: deviceSelect.value
      });
    });

    document.getElementById('btn-home').addEventListener('click', () => {
      vscode.postMessage({ type: 'home' });
    });

    document.getElementById('btn-back').addEventListener('click', () => {
      vscode.postMessage({ type: 'back' });
    });

    document.getElementById('btn-screenshot').addEventListener('click', () => {
      vscode.postMessage({ type: 'saveScreenshot' });
    });

    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshDevices' });
    });

    document.getElementById('btn-disconnect').addEventListener('click', () => {
      vscode.postMessage({ type: 'disconnect' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.type) {
        case 'frame':
          screen.src = 'data:image/jpeg;base64,' + message.data;
          screen.style.display = 'block';
          overlay.classList.add('hidden');
          break;

        case 'devices':
          updateDeviceList(message.devices);
          break;

        case 'stats':
          document.getElementById('fps').textContent = message.fps + ' FPS';
          document.getElementById('latency').textContent = message.latency + ' ms';
          break;

        case 'status':
          document.getElementById('status').textContent = message.text;
          break;

        case 'error':
          overlay.classList.remove('hidden');
          overlay.querySelector('span').textContent = message.text;
          screen.style.display = 'none';
          break;

        case 'disconnected':
          overlay.classList.remove('hidden');
          overlay.querySelector('span').textContent = 'Select a device to start';
          screen.style.display = 'none';
          deviceSelect.value = '';
          document.getElementById('fps').textContent = '-- FPS';
          document.getElementById('latency').textContent = '-- ms';
          break;
      }
    });

    function updateDeviceList(devices) {
      deviceSelect.innerHTML = '<option value="">Select Device...</option>';
      devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.id;
        const state = device.state === 'Booted' ? '' : ' (Shutdown)';
        option.textContent = device.name + state;
        deviceSelect.appendChild(option);
      });
    }

    let resizeTimeout;
    function sendResize() {
      const container = document.querySelector('.simulator-container');
      if (container) {
        const width = Math.round(container.clientWidth);
        vscode.postMessage({ type: 'resize', width: width });
      }
    }

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(sendResize, 200);
    });

    vscode.postMessage({ type: 'init' });
    setTimeout(sendResize, 100);
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  dispose(): void {
    this.stopCapture();
    this.iosSimulator.dispose();
    this.androidEmulator.dispose();
  }
}
