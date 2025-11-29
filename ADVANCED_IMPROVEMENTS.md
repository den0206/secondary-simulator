# 高度な改善 - Phase 2

## 概要

mobiledeck の設計を参考にした第1フェーズの改善に続き、さらなるパフォーマンスと安定性の向上を実装しました。

## 実装した改善

### 1. マルチフレームキュー (mobiledeck 方式)

**変更前:**
```javascript
let pendingFrame = null;  // 1フレームのみ
```

**変更後:**
```javascript
let frameQueue = [];              // 複数フレームキュー
const MAX_FRAME_QUEUE = 3;        // mobiledeck と同じ上限
```

**実装内容:**

#### フレームエンキュー
```javascript
function enqueueFrame(data) {
  totalFramesReceived++;

  // キューが満杯の場合、最も古いフレームを破棄（低遅延アプローチ）
  if (frameQueue.length >= MAX_FRAME_QUEUE) {
    frameQueue.shift();  // 最古フレームを削除
    totalFramesDropped++;
  }

  frameQueue.push(bytes);
  updateQueueDisplay();

  if (!isRendering) {
    requestAnimationFrame(dequeueAndRender);
  }
}
```

#### フレームデキュー
```javascript
function dequeueAndRender() {
  if (isRendering || frameQueue.length === 0) return;

  const frame = frameQueue.shift();
  isRendering = true;

  renderFrame(frame).finally(() => {
    isRendering = false;
    totalFramesRendered++;

    // キューに残りがある場合、続けてレンダリング
    if (frameQueue.length > 0) {
      requestAnimationFrame(dequeueAndRender);
    }
  });
}
```

**効果:**
- ✅ バースト的なフレーム到着に対応
- ✅ スムーズなフレーム処理
- ✅ 低遅延を維持（古いフレームを破棄）

### 2. パフォーマンス統計の追跡

**追加した統計情報:**

```javascript
// Performance tracking
let totalFramesReceived = 0;   // 受信した総フレーム数
let totalFramesRendered = 0;   // レンダリングした総フレーム数
let totalFramesDropped = 0;    // ドロップした総フレーム数
let lastStatsUpdate = performance.now();
```

**統計更新ロジック:**

```javascript
function updateQueueDisplay() {
  document.getElementById('queue').textContent = 'Q:' + frameQueue.length;

  // 1秒ごとにドロップ率を更新
  const now = performance.now();
  if (now - lastStatsUpdate >= 1000) {
    const dropRate = totalFramesReceived > 0
      ? Math.round((totalFramesDropped / totalFramesReceived) * 100)
      : 0;

    // ステータス表示に詳細情報を追加
    const statsEl = document.getElementById('status');
    if (statsEl && statsEl.textContent.includes('Capturing')) {
      statsEl.setAttribute('title',
        'Received: ' + totalFramesReceived +
        ', Rendered: ' + totalFramesRendered +
        ', Dropped: ' + totalFramesDropped +
        ' (' + dropRate + '%)'
      );
    }

    lastStatsUpdate = now;
  }
}
```

**表示内容:**
- キュー深度: `Q:3`
- ツールチップ: `Received: 1250, Rendered: 1200, Dropped: 50 (4%)`

**効果:**
- ✅ パフォーマンス問題の可視化
- ✅ フレームドロップ率の監視
- ✅ デバッグの容易化

### 3. ストリーミングモードの最適化

#### 3.1 キューサイズの制限

**StreamingCapture.ts:**

```typescript
private readonly MAX_PENDING_FRAMES = 3;  // mobiledeck approach
```

**低遅延モード:**
```typescript
if (lowLatency && this.pendingFrames.length >= this.MAX_PENDING_FRAMES) {
  // 低遅延を維持するため、最古フレームを破棄
  const dropped = this.pendingFrames.shift();
  if (dropped && Buffer.isBuffer(dropped)) {
    dropped.fill(0);
  }
  Logger.debug(`Dropped frame to maintain low latency (queue: ${this.pendingFrames.length})`);
}
```

**通常モード:**
```typescript
else if (!lowLatency && this.pendingFrames.length >= this.MAX_PENDING_FRAMES * 2) {
  // 通常モードでは多めにバッファリングするが、それでも制限
  const dropped = this.pendingFrames.shift();
  if (dropped && Buffer.isBuffer(dropped)) {
    dropped.fill(0);
  }
  Logger.debug(`Dropped frame due to queue overflow (queue: ${this.pendingFrames.length})`);
}
```

**効果:**
- ✅ メモリ使用量の制限
- ✅ 低遅延モードでより素早い応答
- ✅ 通常モードでより滑らかな表示

### 4. エラーハンドリングとリカバリー

#### 4.1 連続エラーカウンター

**追加したフィールド:**

```typescript
private consecutiveErrors: number = 0;
private readonly MAX_CONSECUTIVE_ERRORS = 5;
```

#### 4.2 エラー時の処理

**ScreenshotCapture.ts / StreamingCapture.ts:**

```typescript
try {
  const screenshot = await this.manager.takeScreenshot(this.deviceId);

  // 成功: エラーカウンターをリセット
  this.consecutiveErrors = 0;

  // ... フレーム処理 ...
} catch (error) {
  this.consecutiveErrors++;
  Logger.error(
    `Failed to capture frame (${this.consecutiveErrors}/${this.MAX_CONSECUTIVE_ERRORS})`,
    error as Error
  );

  // 連続エラーが多すぎる場合、キャプチャを停止
  if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
    Logger.error('Too many consecutive errors, stopping capture');
    this.stop();
    return;
  }

  // ... クリーンアップ処理 ...
}
```

#### 4.3 指数バックオフ (StreamingCapture のみ)

```typescript
// エラー時は指数バックオフでリトライ
const backoffInterval = Math.min(
  interval * Math.pow(2, this.consecutiveErrors - 1),
  5000  // 最大5秒
);

this.timer = setTimeout(() => {
  this.captureFrame(interval);
}, backoffInterval);
```

**バックオフスケジュール:**
- 1回目のエラー: 通常間隔 (例: 500ms)
- 2回目のエラー: 1000ms
- 3回目のエラー: 2000ms
- 4回目のエラー: 4000ms
- 5回目のエラー: 5000ms (上限)
- 6回目以降: 停止

**効果:**
- ✅ 一時的なエラーからの自動回復
- ✅ 恒久的な問題の早期検出
- ✅ リソースの浪費を防止
- ✅ ログの重複を削減

### 5. リソースクリーンアップの強化

**切断時のクリーンアップ拡張:**

```javascript
case 'disconnected':
  // リソースクリーンアップ
  if (currentBitmap) {
    currentBitmap.close?.();
    currentBitmap = null;
  }
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  frameQueue = [];  // フレームキューをクリア

  // パフォーマンス統計をリセット
  totalFramesReceived = 0;
  totalFramesRendered = 0;
  totalFramesDropped = 0;

  // UI をリセット
  document.getElementById('queue').textContent = 'Q:0';
  // ... その他のUI更新 ...
  break;
```

**効果:**
- ✅ 完全なリソース解放
- ✅ 状態の完全リセット
- ✅ メモリリークの防止

## 改善の全体像

### アーキテクチャ比較

| 項目 | Phase 1 (前回) | Phase 2 (今回) |
|------|---------------|---------------|
| **フレームキュー** | 1フレーム | 3フレーム (mobiledeck) |
| **統計情報** | FPS, レイテンシ | + 受信/レンダリング/ドロップ数 |
| **エラー処理** | 単純なログ | 連続エラー検出 + 自動停止 |
| **リトライ戦略** | なし | 指数バックオフ |
| **キュー管理** | なし | 最古フレーム破棄 |

### パフォーマンス指標

#### Before (Phase 1)
- フレームキュー: 1
- ドロップ率: 不明
- エラー回復: なし

#### After (Phase 2)
- フレームキュー: 最大3フレーム
- ドロップ率: リアルタイム監視
- エラー回復: 自動リトライ + 指数バックオフ

## コード変更サマリー

### 変更ファイル

1. **src/webview/SimulatorWebviewProvider.ts**
   - マルチフレームキュー実装
   - パフォーマンス統計追跡
   - リソースクリーンアップ拡張

2. **src/capture/StreamingCapture.ts**
   - キューサイズ制限
   - エラーハンドリング + 指数バックオフ
   - 低遅延モードの最適化

3. **src/capture/ScreenshotCapture.ts**
   - 連続エラー検出
   - 自動停止機能

## 期待される効果

### パフォーマンス
- ✅ より安定したフレームレート
- ✅ バースト的なフレーム到着への対応
- ✅ スムーズなレンダリング

### 信頼性
- ✅ 一時的なエラーからの自動回復
- ✅ 恒久的な問題の早期検出
- ✅ リソースリークの防止

### 可視性
- ✅ パフォーマンス問題の即座の検出
- ✅ フレームドロップ率の監視
- ✅ デバッグの容易化

### メモリ効率
- ✅ キューサイズの明示的な制限
- ✅ 古いフレームの積極的な破棄
- ✅ 完全なリソースクリーンアップ

## 使用方法

### パフォーマンス統計の確認

キャプチャ中に「Capturing」ステータスにマウスをホバーすると、詳細統計が表示されます：

```
Received: 1250    (受信した総フレーム数)
Rendered: 1200    (レンダリングした総フレーム数)
Dropped: 50       (ドロップしたフレーム数)
(4%)              (ドロップ率)
```

### キュー深度の確認

ステータスバーの `Q:3` 表示で現在のキュー深度を確認できます。

- `Q:0` - キュー空（アイドル状態）
- `Q:1-2` - 正常（良好なパフォーマンス）
- `Q:3` - 満杯（フレーム到着が速い、ドロップが発生している可能性）

### エラーログの確認

連続エラー発生時は Output パネル（"Secondary Simulator"）にログが出力されます：

```
Failed to capture frame (1/5)
Failed to capture frame (2/5)
...
Too many consecutive errors, stopping capture
```

## トラブルシューティング

### フレームドロップ率が高い（10%以上）

**原因:**
- デバイスが高解像度
- システムリソース不足
- ネットワーク遅延（リモートデバイスの場合）

**対策:**
1. `maxWidth` を小さくする（例: 350px）
2. `imageQuality` を下げる（例: 60）
3. `refreshInterval` を大きくする（例: 1000ms）
4. 低遅延モードを有効化

### キャプチャが自動停止する

**原因:**
- 5回連続でスクリーンショット取得に失敗

**対策:**
1. デバイスが起動しているか確認
2. アクセス権限を確認（iOS の場合）
3. adb 接続を確認（Android の場合）
4. Output パネルでエラー詳細を確認

### キューが常に満杯 (Q:3)

**原因:**
- レンダリング速度がフレーム到着速度に追いついていない

**対策:**
1. `streamingFps` を下げる（例: 10）
2. `streamingLowLatency` を有効化
3. ブラウザの GPU アクセラレーションを確認

## 今後の拡張候補

### 短期
1. **適応的キューサイズ**
   - システム負荷に応じて動的にキューサイズを調整
   - ドロップ率が高い場合は自動的に FPS を下げる

2. **統計グラフ表示**
   - FPS、レイテンシ、ドロップ率の時系列グラフ
   - より詳細なパフォーマンス分析

### 中期
1. **MJPEG ストリーミング**
   - mobiledeck の MjpegStream.ts を参考に実装
   - より安定した高フレームレート

2. **複数デバイス同時表示**
   - 各デバイスに独立したキュー
   - グリッドレイアウト

### 長期
1. **機械学習ベースの最適化**
   - フレームの重要度を AI で判定
   - 重要でないフレームを優先的にドロップ

2. **予測的レンダリング**
   - 次のフレームを予測して先行レンダリング
   - よりスムーズな体験

## 参考

- [mobiledeck リポジトリ](https://github.com/mobile-next/mobiledeck)
- [RENDERING_IMPROVEMENTS.md](./RENDERING_IMPROVEMENTS.md) - Phase 1 の改善内容
- [requestAnimationFrame - MDN](https://developer.mozilla.org/en-US/docs/Web/API/window/requestAnimationFrame)
- [ImageBitmap - MDN](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap)

## まとめ

Phase 2 の改善により、以下が実現されました：

1. **マルチフレームキュー** - より安定したフレーム処理
2. **パフォーマンス統計** - 問題の早期発見
3. **ストリーミング最適化** - メモリ効率と低遅延の両立
4. **エラーリカバリー** - 自動回復と早期停止

これらの改善により、Secondary Simulator はより堅牢で高パフォーマンスなツールになりました。
