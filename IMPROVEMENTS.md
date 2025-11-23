# iOS操作機能の改善

## 概要

iOSシミュレータのタップ操作、スワイプ操作、キーボード入力の実装を改善しました。

## 変更内容

### 1. タップ操作の改善

**変更前:**
- AppleScriptを使用してSimulatorウィンドウの位置とサイズを取得
- ウィンドウ内の相対座標を計算してクリック
- 複雑で信頼性が低い

**変更後:**
- `xcrun simctl io <device-id> tap <x> <y>`コマンドを直接使用
- 正規化された座標（0-1）を画面サイズから取得したピクセル座標に変換
- よりシンプルで信頼性が高い

**実装:**
```typescript
async tap(deviceId: string, x: number, y: number): Promise<void> {
  // 画面情報を取得して座標を変換
  const screenInfo = await this.getScreenInfo(deviceId);
  const pixelX = Math.round(x * screenInfo.width);
  const pixelY = Math.round(y * screenInfo.height);

  // xcrun simctl io tapコマンドを実行
  await CommandExecutor.execute('xcrun', [
    'simctl',
    'io',
    deviceId,
    'tap',
    pixelX.toString(),
    pixelY.toString()
  ]);
}
```

### 2. スワイプ操作の改善

**変更前:**
- JXA（JavaScript for Automation）を使用
- ウィンドウ位置とサイズを取得して座標を計算
- CGEventを使用してマウスイベントを送信
- 複雑でエラーが発生しやすい

**変更後:**
- `xcrun simctl io <device-id> drag <x1> <y1> <x2> <y2>`コマンドを直接使用
- 正規化された座標をピクセル座標に変換
- よりシンプルで信頼性が高い

**実装:**
```typescript
async swipe(
  deviceId: string,
  x1: number, y1: number,
  x2: number, y2: number,
  _durationMs?: number
): Promise<void> {
  // 画面情報を取得して座標を変換
  const screenInfo = await this.getScreenInfo(deviceId);
  const pixelX1 = Math.round(x1 * screenInfo.width);
  const pixelY1 = Math.round(y1 * screenInfo.height);
  const pixelX2 = Math.round(x2 * screenInfo.width);
  const pixelY2 = Math.round(y2 * screenInfo.height);

  // xcrun simctl io dragコマンドを実行
  await CommandExecutor.execute('xcrun', [
    'simctl',
    'io',
    deviceId,
    'drag',
    pixelX1.toString(),
    pixelY1.toString(),
    pixelX2.toString(),
    pixelY2.toString()
  ]);
}
```

### 3. キーボード入力の改善

**変更前:**
- WebviewProviderで直接AppleScriptを実行
- iOSとAndroidの処理が混在
- コードの重複

**変更後:**
- `SimulatorManager`に`sendKey`メソッドを追加
- `IOSSimulator`と`AndroidEmulator`でそれぞれ実装
- WebviewProviderは`SimulatorManager`のメソッドを呼び出すだけ
- コードの統一と保守性の向上

**実装:**

#### SimulatorManager（抽象クラス）
```typescript
abstract sendKey(deviceId: string, key: string, special?: boolean): Promise<void>;
```

#### IOSSimulator
```typescript
async sendKey(deviceId: string, key: string, special?: boolean): Promise<void> {
  if (special) {
    // 特殊キー（Backspace, Enter, Escape, Tab, Space）
    const keyCodeMap: { [key: string]: number } = {
      'delete': 51,    // Backspace
      'return': 36,    // Enter
      'escape': 53,    // Escape
      'tab': 48,      // Tab
      'space': 49,     // Space
    };
    // AppleScriptでキーコードを送信
  } else {
    // 通常の文字をエスケープして送信
    const escapedKey = key
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    // AppleScriptでキーストロークを送信
  }
}
```

#### AndroidEmulator
```typescript
async sendKey(deviceId: string, key: string, special?: boolean): Promise<void> {
  if (special) {
    // 特殊キーをKEYCODEに変換
    const keyEventMap: { [key: string]: string } = {
      'delete': 'KEYCODE_DEL',
      'return': 'KEYCODE_ENTER',
      'escape': 'KEYCODE_ESCAPE',
      'tab': 'KEYCODE_TAB',
      'space': 'KEYCODE_SPACE',
    };
    // adb shell input keyeventを実行
  } else {
    // 通常のテキストをadb shell input textで送信
  }
}
```

#### WebviewProvider
```typescript
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
```

## 改善の効果

### 1. 信頼性の向上
- `xcrun simctl io`コマンドはApple公式のツールで、より安定している
- ウィンドウ位置に依存しないため、より確実に動作する

### 2. コードの簡素化
- 複雑なAppleScript/JXAコードを削除
- シンプルなコマンド実行に統一

### 3. 保守性の向上
- キーボード入力処理をSimulatorManagerに統一
- プラットフォーム固有の実装を各クラスに分離

### 4. エラーハンドリングの改善
- エラーを適切にthrowして、呼び出し元で処理
- ログ出力を統一

## 動作確認

### タップ操作
1. iOSシミュレータを起動
2. 拡張機能でデバイスを選択
3. 画面をクリックしてタップ操作を確認

### スワイプ操作
1. iOSシミュレータを起動
2. 拡張機能でデバイスを選択
3. 画面をドラッグしてスワイプ操作を確認

### キーボード入力
1. iOSシミュレータを起動
2. 拡張機能でデバイスを選択
3. テキスト入力フィールドをタップ
4. キーボードで文字を入力して確認

## 注意事項

- `xcrun simctl io tap`と`xcrun simctl io drag`は、デバイスが起動している必要があります
- 座標は画面のピクセル座標である必要があります（正規化された座標から変換）
- キーボード入力は、Simulatorアプリがアクティブである必要があります（AppleScriptでactivate）

## 今後の改善案

1. **キーボード入力の最適化**
   - `xcrun simctl io`にテキスト入力コマンドがあれば使用
   - 現在はAppleScriptを使用しているが、より直接的な方法を検討

2. **エラーハンドリングの強化**
   - デバイスが起動していない場合の明確なエラーメッセージ
   - コマンド実行失敗時のリトライ機能

3. **パフォーマンスの最適化**
   - 画面情報のキャッシュを活用（既に実装済み）
   - 座標変換の最適化

