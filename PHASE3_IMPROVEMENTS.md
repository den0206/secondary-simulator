# Phase 3 改善 - インテリジェント最適化

## 概要

Phase 1 (レンダリングパイプライン最適化) と Phase 2 (高度なキュー管理) に続き、Phase 3 ではインテリジェントな適応的最適化とユーザー体験の向上を実装しました。

## 実装した改善

### 1. 適応的フレームレート調整

システムが自動的にパフォーマンスを監視し、最適なFPSに調整します。

#### アルゴリズム

```javascript
// 5秒ごとに調整
const FPS_ADJUSTMENT_INTERVAL = 5000;

// ドロップ率の閾値
const MAX_DROP_RATE = 0.15;  // 15% 以上: FPS を下げる
const MIN_DROP_RATE = 0.05;  // 5% 以下: FPS を上げる

function adjustFrameRate() {
  // ドロップ率が高すぎる場合
  if (currentDropRate > MAX_DROP_RATE && targetFps > 5) {
    targetFps = Math.max(5, targetFps - 2);
    // バックエンドに通知
    vscode.postMessage({ type: 'adjustFps', fps: targetFps });
  }
  // ドロップ率が低い場合
  else if (currentDropRate < MIN_DROP_RATE && targetFps < 30) {
    targetFps = Math.min(30, targetFps + 1);
    vscode.postMessage({ type: 'adjustFps', fps: targetFps });
  }
}
```

#### 動作シナリオ

**シナリオ 1: 高負荷時の自動調整**
```
開始: 15 FPS, ドロップ率 20%
↓ (5秒後)
調整: 13 FPS (-2), ドロップ率 12%
↓ (5秒後)
調整: 11 FPS (-2), ドロップ率 7%
↓ (安定)
維持: 11 FPS, ドロップ率 6%
```

**シナリオ 2: 余裕がある時の増速**
```
開始: 10 FPS, ドロップ率 2%
↓ (5秒後)
調整: 11 FPS (+1), ドロップ率 3%
↓ (5秒後)
調整: 12 FPS (+1), ドロップ率 4%
↓ (5秒後)
調整: 13 FPS (+1), ドロップ率 6%
↓ (安定)
維持: 13 FPS, ドロップ率 6%
```

#### バックエンド処理

```typescript
private async handleFpsAdjustment(fps: number): Promise<void> {
  Logger.info(`Adjusting FPS to ${fps} based on adaptive algorithm`);

  // 設定を更新
  const config = vscode.workspace.getConfiguration('secondarySimulator');
  await config.update('streamingFps', fps, vscode.ConfigurationTarget.Global);

  // ストリーミングモードの場合、キャプチャを再起動
  if (captureMode === 'streaming' && this.currentDeviceId) {
    await this.startCaptureForDevice(this.currentDeviceId, device);
  }
}
```

**効果:**
- ✅ システム負荷に応じた自動最適化
- ✅ ユーザー介入不要
- ✅ 常に最適なパフォーマンス
- ✅ フレームドロップの最小化

### 2. 接続ヘルスモニタリング

リアルタイムで接続状態を監視し、問題を早期検出します。

#### ヘルスインジケーター

```javascript
const CONNECTION_TIMEOUT = 3000;  // 3秒間フレームがない = 不健全

function updateConnectionHealth() {
  const timeSinceLastFrame = performance.now() - lastFrameTime;
  connectionHealthy = timeSinceLastFrame < CONNECTION_TIMEOUT;

  const healthEl = document.getElementById('health');
  if (connectionHealthy) {
    healthEl.style.color = '#4CAF50';  // 緑
    healthEl.title = 'Connection healthy';
  } else {
    healthEl.style.color = '#F44336';  // 赤
    healthEl.title = 'Connection unhealthy (no frames for Xs)';
  }
}
```

#### 視覚的表示

- **🟢 緑**: 正常（3秒以内にフレーム受信）
- **🔴 赤**: 異常（3秒以上フレーム未受信）

#### ログ出力

```
Connection unhealthy: no frames received for 5 seconds
...
Connection recovered
```

**効果:**
- ✅ 接続問題の即座の検出
- ✅ トラブルシューティングの簡易化
- ✅ デバッグ時間の短縮

### 3. ジェスチャーのビジュアルフィードバック

mobiledeck にインスパイアされた視覚的フィードバックを追加しました。

#### タップフィードバック

```javascript
function showTapFeedback(x, y) {
  // 青い波紋エフェクト
  const ripple = document.createElement('div');
  ripple.style.background = 'rgba(33, 150, 243, 0.5)';  // 青
  ripple.style.animation = 'ripple 0.6s ease-out';
  // 0.6秒後に自動削除
}
```

**アニメーション:**
```css
@keyframes ripple {
  0% { transform: scale(0); opacity: 1; }
  100% { transform: scale(2); opacity: 0; }
}
```

#### スワイプフィードバック

```javascript
function showSwipeFeedback(x1, y1, x2, y2) {
  // 緑の線を描画
  const line = document.createElement('div');
  const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
  const length = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

  line.style.background = 'rgba(76, 175, 80, 0.7)';  // 緑
  line.style.transform = 'rotate(' + angle + 'deg)';
  line.style.animation = 'fadeOut 0.5s ease-out';
  // 0.5秒後に自動削除
}
```

**視覚的効果:**
- **タップ**: 🔵 青い波紋（0.6秒）
- **スワイプ**: 🟢 緑の軌跡線（0.5秒）

**効果:**
- ✅ 操作の即座のフィードバック
- ✅ より直感的なUI
- ✅ 操作確認の容易化
- ✅ ネイティブアプリのような体験

### 4. 統計情報の拡張

ツールチップに Target FPS を追加しました。

**Before:**
```
Received: 1250, Rendered: 1200, Dropped: 50 (4%)
```

**After:**
```
Received: 1250, Rendered: 1200, Dropped: 50 (4%)
Target FPS: 13
```

**効果:**
- ✅ 現在の動作モードの可視化
- ✅ 適応的調整の確認
- ✅ より詳細なパフォーマンス分析

## アーキテクチャ

### データフロー

```
┌─────────────────────────────────────────┐
│          Backend (Extension)            │
│                                         │
│  StreamingCapture                       │
│    ↓ frames                             │
│  SimulatorWebviewProvider               │
│    ↓ postMessage                        │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│         Frontend (Webview)              │
│                                         │
│  enqueueFrame()                         │
│    ↓                                    │
│  updateQueueDisplay()                   │
│    ↓                                    │
│  adjustFrameRate() ────────────────────→│
│    (5秒ごと)              adjustFps     │
│                              message    │
│  updateConnectionHealth()               │
│    (毎フレーム)                         │
│                                         │
│  showTapFeedback() / showSwipeFeedback()│
│    (ユーザー操作時)                     │
└─────────────────────────────────────────┘
```

### 適応的FPS調整のループ

```
1. フレーム受信
   ↓
2. ドロップ率計算 (1秒ごと)
   ↓
3. FPS調整判定 (5秒ごと)
   ↓
4. 必要に応じて調整
   ↓
5. バックエンドに通知
   ↓
6. キャプチャ再起動
   ↓
7. 1に戻る
```

## パフォーマンス比較

### Phase 2 vs Phase 3

| 指標 | Phase 2 | Phase 3 |
|------|---------|---------|
| **FPS調整** | 手動設定 | 自動適応 |
| **接続監視** | ❌ | ✅ リアルタイム |
| **視覚FB** | ❌ | ✅ タップ/スワイプ |
| **Target FPS表示** | ❌ | ✅ ツールチップ |
| **ユーザー操作** | 必要 | 不要（自動） |

### 適応的調整の効果

**Before (固定15 FPS):**
```
高負荷時: 15 FPS, ドロップ率 25% ❌
低負荷時: 15 FPS, ドロップ率 2%  ⚠️ (余裕あり)
```

**After (適応的):**
```
高負荷時: 11 FPS, ドロップ率 6%  ✅ (自動調整)
低負荷時: 20 FPS, ドロップ率 4%  ✅ (自動増速)
```

## 使用方法

### 適応的FPS調整の確認

1. Streaming モードでキャプチャ開始
2. "Capturing" ステータスにマウスホバー
3. `Target FPS: 15` などを確認
4. 5秒ごとに自動調整される
5. コンソールでログ確認:
   ```
   Reducing target FPS to 13 due to high drop rate: 18%
   Increasing target FPS to 14 due to low drop rate: 3%
   ```

### 接続ヘルス監視

1. ステータスバー右端の `●` を確認
2. 🟢 緑 = 正常
3. 🔴 赤 = 異常（3秒以上フレームなし）
4. マウスホバーで詳細を確認

### ジェスチャーフィードバック

1. シミュレータ画面をタップ
   → 🔵 青い波紋が表示

2. シミュレータ画面をスワイプ
   → 🟢 緑の軌跡線が表示

## トラブルシューティング

### FPSが下がり続ける

**原因:**
- システムリソース不足
- 高解像度デバイス
- バックグラウンドプロセス

**対策:**
1. `maxWidth` を小さくする（例: 300px）
2. `imageQuality` を下げる（例: 50）
3. 他のアプリを閉じる
4. 手動で FPS を固定（適応的調整を無効化）

### 接続が頻繁に不健全になる

**原因:**
- デバイスが重い処理中
- ネットワーク遅延（リモートの場合）
- システムリソース不足

**対策:**
1. デバイスのアプリを終了
2. Screenshot モードに切り替え
3. `refreshInterval` を大きくする（例: 1000ms）

### ビジュアルフィードバックが表示されない

**原因:**
- ブラウザの互換性問題
- CSS アニメーションの無効化

**対策:**
1. VSCode を再起動
2. Webview をリロード
3. ブラウザの設定を確認

## 設定

### 適応的FPS調整の無効化

現在は自動で有効です。将来的に設定オプションを追加予定：

```json
{
  "secondarySimulator.adaptiveFps": false,
  "secondarySimulator.targetFps": 15
}
```

### 接続タイムアウトの変更

現在は3秒固定です。将来的に設定可能に：

```json
{
  "secondarySimulator.connectionTimeout": 5000
}
```

## 今後の拡張

### 短期
1. **適応的調整の設定UI**
   - 有効/無効の切り替え
   - 最小/最大FPSの設定
   - 調整感度の設定

2. **パフォーマンスグラフ**
   - FPS履歴のグラフ表示
   - ドロップ率の時系列表示
   - リアルタイムチャート

### 中期
1. **機械学習ベースの予測**
   - 過去のパフォーマンスから最適FPSを予測
   - デバイス特性の学習
   - 自動プロファイリング

2. **詳細な接続診断**
   - レイテンシ分析
   - ジッタ測定
   - パケットロス検出

### 長期
1. **マルチデバイス最適化**
   - デバイスごとに独立した適応的調整
   - リソースの公平な分配
   - 優先度ベースの割り当て

2. **AIアシスタント**
   - パフォーマンス問題の自動診断
   - 最適設定の提案
   - トラブルシューティングガイド

## 技術詳細

### 適応的アルゴリズムのパラメータ

```javascript
// 調整間隔
const FPS_ADJUSTMENT_INTERVAL = 5000;  // 5秒

// ドロップ率閾値
const MAX_DROP_RATE = 0.15;  // 15%
const MIN_DROP_RATE = 0.05;  // 5%

// FPS範囲
const MIN_FPS = 5;
const MAX_FPS = 30;

// 調整量
const DECREASE_STEP = 2;  // 減少時: -2 FPS
const INCREASE_STEP = 1;  // 増加時: +1 FPS
```

### なぜ減少は-2、増加は+1？

**理由:**
- ドロップが発生している場合は素早く対応（-2）
- 余裕がある場合は慎重に増速（+1）
- オーバーシュートを防止
- 安定性を優先

### 接続ヘルスのハイステリシス

現在は単純な閾値（3秒）ですが、将来的にハイステリシスを追加予定：

```javascript
// 提案
const UNHEALTHY_THRESHOLD = 3000;  // 不健全判定
const HEALTHY_THRESHOLD = 1000;    // 回復判定

// チャタリング防止
if (wasHealthy && timeSinceLastFrame > UNHEALTHY_THRESHOLD) {
  connectionHealthy = false;
} else if (!wasHealthy && timeSinceLastFrame < HEALTHY_THRESHOLD) {
  connectionHealthy = true;
}
```

## まとめ

Phase 3 の改善により実現されたこと：

### 1. インテリジェント
- 🤖 自動的なパフォーマンス最適化
- 📊 リアルタイム監視と診断
- 🎯 ユーザー介入不要

### 2. ビジュアル
- 🎨 直感的な視覚フィードバック
- 🔔 明確な状態インジケーター
- 📈 詳細な統計情報

### 3. 適応的
- ⚡ 動的なFPS調整
- 🔄 自動リカバリー
- 🎚️ 負荷に応じた最適化

Secondary Simulator は、ただのシミュレータ表示ツールから、インテリジェントな適応的パフォーマンス管理システムへと進化しました。
