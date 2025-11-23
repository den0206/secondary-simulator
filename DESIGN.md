# 設計書: iOS/Android シミュレータ表示拡張機能

## 概要

VSCode/Cursor のセカンダリサイドバーに、iOS/Android シミュレータの画面を表示し、操作できる拡張機能を開発します。

## 技術調査結果

### 実現可能性: ✅ 技術的に可能

既存の拡張機能「Docked Android iOS Emulator」が類似機能を実装しており、実現可能性は証明されています。

### 主要技術

| 技術要素 | iOS | Android |
|----------|-----|---------|
| デバイス検出 | `xcrun simctl list devices` | `adb devices` |
| スクリーンキャプチャ | `xcrun simctl io screenshot` | `adb exec-out screencap -p` |
| ストリーミング | `xcrun simctl io recordVideo --type=fmp4` | `adb screenrecord --output-format=h264` |
| タップ入力 | `xcrun simctl io tap x y` | `adb shell input tap x y` |
| スワイプ入力 | `xcrun simctl io drag x1 y1 x2 y2` | `adb shell input swipe x1 y1 x2 y2` |

### 参考資料

- [VSCode Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [VSCode Sidebars UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/sidebars)
- [iOS Dev Recipes - simctl](https://www.iosdev.recipes/simctl/)
- [scrcpy GitHub](https://github.com/Genymobile/scrcpy)

---

## アプローチ比較

| アプローチ | 遅延 | 実装難易度 | CPU負荷 | 依存関係 |
|------------|------|------------|---------|----------|
| **スクリーンショット方式** | 500ms-5s | 低 | 中 | なし |
| **ストリーミング方式** | 35-100ms | 高 | 高 | ffmpeg |
| **ハイブリッド方式** (採用) | 100-200ms | 中 | 中 | ffmpeg (オプション) |

### 採用: ハイブリッド方式

**Phase 1**: スクリーンショット方式で MVP を素早くリリース
**Phase 2**: ストリーミング方式をオプションとして追加

---

## アーキテクチャ

### システム構成図

```
┌─────────────────────────────────────────────────────────────────┐
│                     VSCode Extension                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────────────────────┐   │
│  │  Extension Host  │    │    Webview (Sidebar)              │   │
│  │                  │    │                                    │   │
│  │ ┌──────────────┐ │    │  ┌──────────────────────────────┐ │   │
│  │ │ Capture      │ │    │  │  Device Selector              │ │   │
│  │ │ Strategy     │ │    │  │  ┌─────┐ ┌─────┐              │ │   │
│  │ │              │ │    │  │  │ iOS │ │ And │              │ │   │
│  │ │ ┌──────────┐ │ │    │  │  └─────┘ └─────┘              │ │   │
│  │ │ │Screenshot│ │◄┼────┼──┤                                │ │   │
│  │ │ └──────────┘ │ │    │  │  ┌──────────────────────────┐ │ │   │
│  │ │ ┌──────────┐ │ │    │  │  │                          │ │ │   │
│  │ │ │Streaming │ │ │    │  │  │   Canvas/Image Display   │ │ │   │
│  │ │ │(Phase 2) │ │ │    │  │  │                          │ │ │   │
│  │ │ └──────────┘ │ │    │  │  │   Click/Touch Events     │ │ │   │
│  │ └──────────────┘ │    │  │  │                          │ │ │   │
│  │        │         │    │  │  └──────────────────────────┘ │ │   │
│  │        ▼         │    │  │                                │ │   │
│  │ ┌──────────────┐ │    │  │  ┌─────────────────────────┐  │ │   │
│  │ │ Input        │─┼────┼──►  │ Control Buttons         │  │ │   │
│  │ │ Handler      │ │    │  │  │ [Home][Back][Menu]      │  │ │   │
│  │ └──────────────┘ │    │  │  └─────────────────────────┘  │ │   │
│  └──────────────────┘    │  └──────────────────────────────┘ │   │
│           │               └──────────────────────────────────┘   │
└───────────┼──────────────────────────────────────────────────────┘
            │
            ▼
    ┌───────────────┐         ┌───────────────┐
    │ iOS Simulator │         │ Android       │
    │ xcrun simctl  │         │ Emulator adb  │
    └───────────────┘         └───────────────┘
```

### データフロー

```
1. ユーザーがデバイスを選択
   ↓
2. SimulatorManager がデバイスを検出・起動
   ↓
3. CaptureStrategy が定期的にフレームを取得
   ↓
4. 差分検出で変化があれば Base64 エンコード
   ↓
5. postMessage で Webview に送信
   ↓
6. Webview で Canvas/Image を更新表示
   ↓
7. ユーザーがクリック/タップ
   ↓
8. 座標を正規化して InputHandler に送信
   ↓
9. シミュレータコマンドを実行
```

---

## ディレクトリ構造

```
secondary-simulator/
├── src/
│   ├── extension.ts                    # エントリーポイント
│   │
│   ├── webview/
│   │   ├── SimulatorWebviewProvider.ts # Webview プロバイダー
│   │   ├── webview.html                # メイン HTML
│   │   ├── webview.css                 # スタイル
│   │   └── webview.js                  # フロントエンド JS
│   │
│   ├── simulator/
│   │   ├── SimulatorManager.ts         # 抽象基底クラス
│   │   ├── IOSSimulator.ts             # iOS 実装
│   │   ├── AndroidEmulator.ts          # Android 実装
│   │   └── DeviceDetector.ts           # デバイス検出
│   │
│   ├── capture/
│   │   ├── CaptureStrategy.ts          # Strategy インターフェース
│   │   ├── ScreenshotStrategy.ts       # Phase 1: スクリーンショット
│   │   ├── StreamingStrategy.ts        # Phase 2: ストリーミング
│   │   └── FrameBuffer.ts              # フレームバッファ管理
│   │
│   ├── input/
│   │   ├── InputHandler.ts             # 入力ハンドラー
│   │   ├── GestureRecognizer.ts        # ジェスチャー認識
│   │   └── CoordinateTransformer.ts    # 座標変換
│   │
│   └── utils/
│       ├── Logger.ts                   # ロギング
│       ├── ConfigManager.ts            # 設定管理
│       └── CommandExecutor.ts          # コマンド実行ユーティリティ
│
├── resources/
│   └── icons/                          # アイコン
│
├── test/
│   └── suite/                          # テスト
│
├── package.json
├── tsconfig.json
├── .vscodeignore
└── README.md
```

---

## 主要コンポーネント設計

### 1. CaptureStrategy (Strategy パターン)

```typescript
interface CaptureStrategy {
  start(deviceId: string): void;
  stop(): void;
  onFrame(callback: (frame: Buffer) => void): void;
}

class ScreenshotStrategy implements CaptureStrategy {
  private interval: NodeJS.Timer | null = null;
  private frameCallback: ((frame: Buffer) => void) | null = null;

  constructor(private intervalMs: number = 500) {}

  start(deviceId: string): void {
    this.interval = setInterval(async () => {
      const screenshot = await this.capture(deviceId);
      if (this.frameCallback) {
        this.frameCallback(screenshot);
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  onFrame(callback: (frame: Buffer) => void): void {
    this.frameCallback = callback;
  }

  private async capture(deviceId: string): Promise<Buffer> {
    // 実装はプラットフォームごとに異なる
  }
}

class StreamingStrategy implements CaptureStrategy {
  // Phase 2: ffmpeg を使用したストリーミング実装
}
```

### 2. SimulatorManager (抽象クラス)

```typescript
interface Device {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  state: 'booted' | 'shutdown';
  runtime?: string;
}

abstract class SimulatorManager {
  abstract listDevices(): Promise<Device[]>;
  abstract boot(deviceId: string): Promise<void>;
  abstract shutdown(deviceId: string): Promise<void>;
  abstract takeScreenshot(deviceId: string): Promise<Buffer>;
  abstract tap(deviceId: string, x: number, y: number): Promise<void>;
  abstract swipe(
    deviceId: string,
    x1: number, y1: number,
    x2: number, y2: number,
    duration?: number
  ): Promise<void>;
  abstract pressHome(deviceId: string): Promise<void>;
  abstract pressBack(deviceId: string): Promise<void>;
}
```

### 3. IOSSimulator

```typescript
class IOSSimulator extends SimulatorManager {
  async listDevices(): Promise<Device[]> {
    const { stdout } = await execAsync('xcrun simctl list devices -j');
    const data = JSON.parse(stdout);
    // パース処理
    return devices;
  }

  async takeScreenshot(deviceId: string): Promise<Buffer> {
    const tmpFile = path.join(os.tmpdir(), `sim-${Date.now()}.png`);
    await execAsync(`xcrun simctl io ${deviceId} screenshot ${tmpFile}`);
    const buffer = await fs.readFile(tmpFile);
    await fs.unlink(tmpFile);
    return buffer;
  }

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    await execAsync(`xcrun simctl io ${deviceId} tap ${x} ${y}`);
  }

  async pressHome(deviceId: string): Promise<void> {
    await execAsync(`xcrun simctl io ${deviceId} home`);
  }
}
```

### 4. AndroidEmulator

```typescript
class AndroidEmulator extends SimulatorManager {
  async listDevices(): Promise<Device[]> {
    const { stdout } = await execAsync('adb devices -l');
    // パース処理
    return devices;
  }

  async takeScreenshot(deviceId: string): Promise<Buffer> {
    const { stdout } = await execAsync(
      `adb -s ${deviceId} exec-out screencap -p`,
      { encoding: 'binary' }
    );
    return Buffer.from(stdout, 'binary');
  }

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    await execAsync(`adb -s ${deviceId} shell input tap ${x} ${y}`);
  }

  async pressHome(deviceId: string): Promise<void> {
    await execAsync(`adb -s ${deviceId} shell input keyevent KEYCODE_HOME`);
  }

  async pressBack(deviceId: string): Promise<void> {
    await execAsync(`adb -s ${deviceId} shell input keyevent KEYCODE_BACK`);
  }
}
```

### 5. FrameBuffer (差分検出)

```typescript
import * as crypto from 'crypto';

class FrameBuffer {
  private lastHash: string = '';

  shouldSendFrame(newFrame: Buffer): boolean {
    const newHash = crypto.createHash('md5')
      .update(newFrame)
      .digest('hex');

    if (newHash === this.lastHash) {
      return false;
    }

    this.lastHash = newHash;
    return true;
  }

  reset(): void {
    this.lastHash = '';
  }
}
```

### 6. AdaptiveRefreshController

```typescript
class AdaptiveRefreshController {
  private baseInterval: number;
  private currentInterval: number;
  private consecutiveNoChanges: number = 0;

  constructor(baseInterval: number = 500) {
    this.baseInterval = baseInterval;
    this.currentInterval = baseInterval;
  }

  adjustInterval(frameChanged: boolean): number {
    if (frameChanged) {
      this.currentInterval = this.baseInterval;
      this.consecutiveNoChanges = 0;
    } else {
      this.consecutiveNoChanges++;
      if (this.consecutiveNoChanges > 5) {
        this.currentInterval = Math.min(
          this.currentInterval * 1.5,
          3000
        );
      }
    }
    return this.currentInterval;
  }

  reset(): void {
    this.currentInterval = this.baseInterval;
    this.consecutiveNoChanges = 0;
  }
}
```

### 7. CommandExecutor (セキュリティ強化)

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

class CommandExecutor {
  private allowedCommands = new Set([
    'xcrun', 'adb', 'emulator'
  ]);

  async execute(command: string, args: string[]): Promise<string> {
    const baseCommand = command.split('/').pop()!;

    if (!this.allowedCommands.has(baseCommand)) {
      throw new Error(`Command not allowed: ${command}`);
    }

    // 引数のサニタイズ
    const sanitizedArgs = args.map(arg =>
      arg.replace(/[;&|`$()]/g, '')
    );

    const { stdout } = await execFileAsync(command, sanitizedArgs);
    return stdout;
  }
}
```

---

## package.json

```json
{
  "name": "secondary-simulator",
  "displayName": "Secondary Simulator",
  "description": "Display iOS/Android simulators in secondary sidebar",
  "version": "0.1.0",
  "publisher": "your-publisher-name",
  "engines": {
    "vscode": "^1.80.0"
  },
  "categories": ["Debuggers", "Other"],
  "keywords": ["ios", "android", "simulator", "emulator", "preview"],
  "activationEvents": [],
  "main": "./out/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [{
        "id": "simulator-container",
        "title": "Simulator",
        "icon": "$(device-mobile)"
      }]
    },
    "views": {
      "simulator-container": [{
        "type": "webview",
        "id": "simulatorView",
        "name": "Device Preview"
      }]
    },
    "commands": [
      {
        "command": "simulator.selectDevice",
        "title": "Simulator: Select Device"
      },
      {
        "command": "simulator.startCapture",
        "title": "Simulator: Start Capture"
      },
      {
        "command": "simulator.stopCapture",
        "title": "Simulator: Stop Capture"
      },
      {
        "command": "simulator.takeScreenshot",
        "title": "Simulator: Save Screenshot"
      },
      {
        "command": "simulator.home",
        "title": "Simulator: Press Home"
      },
      {
        "command": "simulator.back",
        "title": "Simulator: Press Back"
      },
      {
        "command": "simulator.refresh",
        "title": "Simulator: Refresh Device List"
      }
    ],
    "configuration": {
      "title": "Secondary Simulator",
      "properties": {
        "secondarySimulator.captureMode": {
          "type": "string",
          "default": "screenshot",
          "enum": ["screenshot", "streaming"],
          "enumDescriptions": [
            "Screenshot mode (no dependencies)",
            "Streaming mode (requires ffmpeg)"
          ],
          "description": "Capture mode for simulator screen"
        },
        "secondarySimulator.refreshInterval": {
          "type": "number",
          "default": 500,
          "minimum": 100,
          "maximum": 5000,
          "description": "Screenshot refresh interval in milliseconds"
        },
        "secondarySimulator.imageQuality": {
          "type": "number",
          "default": 80,
          "minimum": 10,
          "maximum": 100,
          "description": "JPEG compression quality (10-100)"
        },
        "secondarySimulator.maxWidth": {
          "type": "number",
          "default": 400,
          "description": "Maximum display width in pixels"
        },
        "secondarySimulator.adaptiveRefresh": {
          "type": "boolean",
          "default": true,
          "description": "Automatically adjust refresh rate based on screen activity"
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run compile",
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "lint": "eslint src --ext ts",
    "test": "node ./out/test/runTest.js"
  },
  "devDependencies": {
    "@types/node": "^18.x",
    "@types/vscode": "^1.80.0",
    "@typescript-eslint/eslint-plugin": "^6.x",
    "@typescript-eslint/parser": "^6.x",
    "eslint": "^8.x",
    "typescript": "^5.x"
  }
}
```

---

## UI 設計

### Webview レイアウト

```
┌─────────────────────────────┐
│ [iOS ▼] [iPhone 15 Pro ▼]   │  ← デバイス選択
├─────────────────────────────┤
│                             │
│ ┌─────────────────────────┐ │
│ │                         │ │
│ │                         │ │
│ │   シミュレータ画面       │ │  ← クリック可能な領域
│ │   (Canvas/Image)        │ │
│ │                         │ │
│ │                         │ │
│ └─────────────────────────┘ │
│                             │
│   [⌂] [←] [☰] [📷] [⟳]    │  ← コントロールボタン
│                             │
│   12 FPS | 250ms latency    │  ← ステータス表示
└─────────────────────────────┘
```

### Webview HTML

```html
<!DOCTYPE html>
<html>
<head>
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
    }

    .simulator-container {
      position: relative;
      width: 100%;
      background: #000;
      border-radius: 8px;
      overflow: hidden;
    }

    #simulator-screen {
      width: 100%;
      height: auto;
      display: block;
      cursor: pointer;
    }

    .loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.7);
      color: white;
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
      font-size: 14px;
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
      font-size: 11px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border);
      opacity: 0.7;
    }

    .no-device {
      text-align: center;
      padding: 40px 20px;
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

  <div class="simulator-container" id="container">
    <img id="simulator-screen" src="" alt="Simulator Screen" style="display: none;" />
    <div class="loading-overlay" id="loading">
      <span>Select a device to start</span>
    </div>
  </div>

  <div class="controls">
    <button class="control-btn" id="btn-home" title="Home">⌂</button>
    <button class="control-btn" id="btn-back" title="Back">←</button>
    <button class="control-btn" id="btn-menu" title="Menu">☰</button>
    <button class="control-btn" id="btn-screenshot" title="Save Screenshot">📷</button>
    <button class="control-btn" id="btn-refresh" title="Refresh">⟳</button>
  </div>

  <div class="status-bar">
    <span id="fps">-- FPS</span>
    <span id="status">Idle</span>
    <span id="latency">-- ms</span>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const screen = document.getElementById('simulator-screen');
    const loading = document.getElementById('loading');
    const platformSelect = document.getElementById('platform');
    const deviceSelect = document.getElementById('device');

    // タップイベント
    screen.addEventListener('click', (e) => {
      const rect = screen.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;

      vscode.postMessage({ type: 'tap', x, y });
    });

    // デバイス選択
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

    // コントロールボタン
    document.getElementById('btn-home').addEventListener('click', () => {
      vscode.postMessage({ type: 'home' });
    });

    document.getElementById('btn-back').addEventListener('click', () => {
      vscode.postMessage({ type: 'back' });
    });

    document.getElementById('btn-menu').addEventListener('click', () => {
      vscode.postMessage({ type: 'menu' });
    });

    document.getElementById('btn-screenshot').addEventListener('click', () => {
      vscode.postMessage({ type: 'saveScreenshot' });
    });

    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshDevices' });
    });

    // メッセージ受信
    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.type) {
        case 'frame':
          screen.src = `data:image/jpeg;base64,${message.data}`;
          screen.style.display = 'block';
          loading.style.display = 'none';
          break;

        case 'devices':
          updateDeviceList(message.devices);
          break;

        case 'stats':
          document.getElementById('fps').textContent = `${message.fps} FPS`;
          document.getElementById('latency').textContent = `${message.latency} ms`;
          break;

        case 'status':
          document.getElementById('status').textContent = message.text;
          break;

        case 'error':
          loading.style.display = 'flex';
          loading.querySelector('span').textContent = message.text;
          break;
      }
    });

    function updateDeviceList(devices) {
      deviceSelect.innerHTML = '<option value="">Select Device...</option>';
      devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = `${device.name} (${device.state})`;
        deviceSelect.appendChild(option);
      });
    }

    // 初期化
    vscode.postMessage({ type: 'init' });
  </script>
</body>
</html>
```

---

## パフォーマンス最適化

### 1. 差分検出
- フレームのハッシュを比較し、変化がない場合は送信をスキップ
- 帯域幅と CPU 使用率を削減

### 2. 適応的リフレッシュレート
- 画面に変化がない場合、自動的にリフレッシュ間隔を延長
- 変化を検出したら即座に高速モードに復帰
- 省電力とレスポンシブ性のバランス

### 3. 画像圧縮
- JPEG 形式で圧縮（デフォルト品質 80%）
- 表示サイズに合わせてリサイズ
- Base64 エンコードのオーバーヘッドを考慮

### 4. 非同期処理
- スクリーンキャプチャを非同期で実行
- 前回のキャプチャ完了を待機（重複実行防止）
- エラー時のリトライ機構

---

## エラーハンドリング

### エラー種別と対応

| エラー | 原因 | 対応 |
|--------|------|------|
| シミュレータ未検出 | Xcode/Android SDK 未インストール | インストール手順を案内 |
| デバイス未起動 | シミュレータが shutdown 状態 | 起動を促すメッセージ |
| コマンド実行失敗 | 権限不足、タイムアウト | エラーログ出力、リトライ |
| スクリーンショット失敗 | デバイス応答なし | 接続状態を確認、再接続 |

### エラーメッセージ例

```typescript
const errorMessages = {
  noXcode: 'Xcode is not installed. Please install Xcode from the App Store.',
  noAdb: 'ADB is not found. Please install Android SDK and add it to PATH.',
  noDevices: 'No devices found. Please start a simulator or emulator.',
  captureFailed: 'Failed to capture screen. Please check device connection.',
  tapFailed: 'Failed to send tap event. Device may be unresponsive.',
};
```

---

## セキュリティ考慮事項

### 1. コマンドインジェクション対策
- ホワイトリスト方式でコマンドを制限
- `execFile` を使用（シェル経由でない）
- 引数のサニタイズ

### 2. ファイルアクセス
- 一時ファイルは `os.tmpdir()` に保存
- 使用後は即座に削除
- ファイル名に UUID を使用

### 3. Webview セキュリティ
- `enableScripts: true` は必要最小限
- 外部リソースの読み込みを制限
- CSP (Content Security Policy) の設定

---

## 実装フェーズ

### Phase 1: MVP (2-3週間)

- [ ] プロジェクトセットアップ (TypeScript, ESLint)
- [ ] 基本的な Webview セットアップ
- [ ] iOS デバイス検出・一覧表示
- [ ] Android デバイス検出・一覧表示
- [ ] スクリーンショット方式のキャプチャ
- [ ] 基本的なタップ入力
- [ ] ホーム/戻るボタン
- [ ] 基本的なエラーハンドリング

### Phase 2: 改善 (2週間)

- [ ] 差分検出による最適化
- [ ] 適応的リフレッシュレート
- [ ] スワイプジェスチャー
- [ ] 画像圧縮・リサイズ
- [ ] 設定 UI
- [ ] デバッグログ機能

### Phase 3: ストリーミング (オプション, 2-3週間)

- [ ] ffmpeg 検出・統合
- [ ] MJPEG ストリーミング実装
- [ ] 低遅延モード
- [ ] フレームレート調整

### Phase 4: 拡張機能 (将来)

- [ ] 複数デバイス同時表示
- [ ] 録画機能
- [ ] キーボード入力
- [ ] ログ表示
- [ ] ショートカットキー

---

## リスクと対策

| リスク | 影響度 | 対策 |
|--------|--------|------|
| iOS Simulator API の制限 | 高 | 公式コマンドを優先使用、代替手段を調査 |
| ffmpeg のインストール要求 | 中 | Phase 1 では不要、Phase 2 ではオプション化 |
| パフォーマンス問題 | 中 | 適応的リフレッシュ、品質設定で調整可能 |
| macOS 限定機能 (iOS) | 低 | プラットフォーム検出、Android のみでも有用 |
| VSCode API の変更 | 低 | 安定した API を使用、定期的な更新確認 |

---

## 今後の拡張可能性

### 1. 録画機能
- 操作を録画して動画ファイルとして保存
- GIF 出力オプション

### 2. 複数デバイス同時表示
- タブまたは分割表示で複数デバイスを並列表示
- 同一操作の複数デバイス同時実行

### 3. ログ表示
- シミュレータのコンソールログを表示
- フィルタリング・検索機能

### 4. ショートカットキー
- キーボードショートカットで操作
- カスタマイズ可能なキーバインド

### 5. ディープリンク
- URL スキームによるアプリ起動
- インテント送信 (Android)

---

## 参考: 既存拡張機能

| 拡張機能 | 機能 | 備考 |
|----------|------|------|
| [Docked Android iOS Emulator](https://marketplace.visualstudio.com/items?itemName=gfrnr.docked-android-ios-emulator) | リアルタイムストリーミング | ソース非公開 |
| [Android iOS Emulator](https://marketplace.visualstudio.com/items?itemName=DiemasMichiels.emulate) | 起動のみ | ストリーミングなし |
| [SimCode](https://github.com/sudharsan-selvaraj/simcode) | 管理機能中心 | オープンソース |
