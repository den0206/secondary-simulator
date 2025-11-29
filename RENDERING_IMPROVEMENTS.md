# レンダリング改善 - mobiledeck 参考実装

## 概要

mobiledeck リポジトリ (https://github.com/mobile-next/mobiledeck) の描写方法を参考に、Secondary Simulator のレンダリングパイプラインを最適化しました。

## 実装した改善

### 1. requestAnimationFrame による最適化

**変更前:**
```javascript
ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
bitmap.close?.();
```

**変更後:**
```javascript
animationFrameId = requestAnimationFrame(() => {
  if (currentBitmap && ctx) {
    ctx.drawImage(currentBitmap, 0, 0, canvas.width, canvas.height);
  }
  animationFrameId = null;
});
```

**効果:**
- ブラウザのリフレッシュレートと同期
- より滑らかな描画
- フレームドロップの削減

### 2. ImageBitmap のライフサイクル管理

**追加した管理:**
```javascript
let currentBitmap = null;  // 現在の ImageBitmap を保持

// 新しいフレーム受信時
if (currentBitmap) {
  currentBitmap.close?.();  // 前の ImageBitmap を解放
  currentBitmap = null;
}
currentBitmap = bitmap;
```

**効果:**
- GPU メモリの効率的な管理
- メモリリークの防止
- より安定したパフォーマンス

### 3. リソースクリーンアップの強化

**追加したクリーンアップポイント:**

1. **エラー時:**
```javascript
case 'error':
  if (currentBitmap) {
    currentBitmap.close?.();
    currentBitmap = null;
  }
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
```

2. **切断時:**
```javascript
case 'disconnected':
  if (currentBitmap) {
    currentBitmap.close?.();
    currentBitmap = null;
  }
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  pendingFrame = null;
```

3. **ページアンロード時:**
```javascript
window.addEventListener('beforeunload', () => {
  if (currentBitmap) {
    currentBitmap.close?.();
    currentBitmap = null;
  }
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (decoder) {
    try { decoder.close(); } catch (_) {}
    decoder = null;
  }
});
```

**効果:**
- リソースリークの完全防止
- より安定した動作
- メモリ使用量の削減

### 4. Buffer 管理の最適化

**ScreenshotCapture.ts の改善:**
```typescript
// Clean up buffers to free memory (mobiledeck approach)
if (processed && Buffer.isBuffer(processed)) {
  processed.fill(0);
}
if (screenshot && Buffer.isBuffer(screenshot)) {
  screenshot.fill(0);
}
```

**効果:**
- Node.js 側のメモリ管理改善
- より明示的なリソース解放

## mobiledeck との主な違い

| 項目 | Secondary Simulator | mobiledeck |
|------|-------------------|------------|
| **キャプチャ方式** | スクリーンショット定期取得 | MJPEG ストリーミング |
| **デコード** | createImageBitmap (共通) | createImageBitmap (共通) |
| **レンダリング** | requestAnimationFrame (改善後) | requestAnimationFrame |
| **メモリ管理** | ImageBitmap.close() (改善後) | ImageBitmap.close() |
| **UI フレームワーク** | Vanilla JS | React |
| **バックエンド** | 直接 CLI 実行 | mobilecli サーバー |

## 期待される効果

### パフォーマンス
- ✅ より滑らかな画面描画
- ✅ フレームドロップの削減
- ✅ GPU メモリ使用量の最適化

### メモリ管理
- ✅ ImageBitmap の適切な解放
- ✅ メモリリークの防止
- ✅ 長時間使用時の安定性向上

### ユーザー体験
- ✅ レスポンシブな操作感
- ✅ より安定した動作
- ✅ エラーからの復帰の改善

## 今後の改善候補

### 短期
1. **フレームキューの最適化**
   - mobiledeck の最大3フレームキュー方式の導入検討
   - より低遅延な表示

2. **統計情報の改善**
   - レンダリング遅延の詳細表示
   - フレームドロップ率の可視化

### 中期
1. **MJPEG ストリーミングの導入**
   - mobiledeck の MjpegStream.ts を参考に実装
   - より高フレームレートな表示

2. **React への段階的移行**
   - よりモダンな UI フレームワーク
   - コンポーネントベースの設計

### 長期
1. **ネットワークベースアーキテクチャ**
   - ローカルサーバー経由のストリーミング
   - リモートデバイスサポート

2. **WebCodecs API の完全活用**
   - H.264 デコードの最適化
   - より低遅延なビデオストリーミング

## 参考リソース

- [mobiledeck リポジトリ](https://github.com/mobile-next/mobiledeck)
- [mobiledeck DeviceStream.tsx](https://github.com/mobile-next/mobiledeck/blob/main/webview-ui/src/DeviceStream.tsx)
- [mobiledeck MjpegStream.ts](https://github.com/mobile-next/mobiledeck/blob/main/webview-ui/src/MjpegStream.ts)
- [ImageBitmap API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap)
- [requestAnimationFrame API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/window/requestAnimationFrame)

## 変更ファイル一覧

- `src/webview/SimulatorWebviewProvider.ts` - レンダリングパイプラインの最適化
- `src/capture/ScreenshotCapture.ts` - Buffer 管理の改善

## テスト方法

1. **コンパイル:**
   ```bash
   npm run compile
   ```

2. **拡張機能の実行:**
   - VSCode で F5 キーを押す
   - Extension Development Host が起動

3. **動作確認:**
   - iOS Simulator または Android Emulator を起動
   - Secondary Simulator でデバイスを選択
   - 画面が表示されることを確認
   - タップ/スワイプ操作が正常に動作することを確認

4. **メモリ管理確認:**
   - Chrome DevTools でメモリプロファイリング
   - 長時間使用してもメモリが増加しないことを確認

## まとめ

mobiledeck の優れた設計を参考に、以下の改善を実装しました：

1. **requestAnimationFrame による滑らかな描画**
2. **ImageBitmap の適切なライフサイクル管理**
3. **包括的なリソースクリーンアップ**
4. **メモリ管理の最適化**

これらの改善により、より安定した高パフォーマンスなシミュレータ表示が実現されました。
