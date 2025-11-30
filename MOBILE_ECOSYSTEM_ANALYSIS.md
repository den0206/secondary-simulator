# Mobile Next エコシステム分析レポート

## 概要

Mobile Nextは、モバイルデバイス（iOS/Android）の開発・テスト・自動化を支援するエコシステムを提供しています。主要な3つのコンポーネントがあります：

1. **mobiledeck** - VSCode拡張機能（IDE統合）
2. **mobile-mcp** - MCPサーバー（AIエージェント統合）
3. **mobilecli** - コマンドラインツール（コアエンジン）

## コンポーネント詳細

### 1. mobilecli
**リポジトリ**: https://github.com/mobile-next/mobilecli

**役割**:
- iOS/Androidデバイス、シミュレータ、エミュレータを管理するユニバーサルCLIツール
- JSON-RPCサーバーとして動作可能
- デバイス操作のコアエンジン

**主要機能**:
- デバイス一覧取得
- スクリーンキャプチャ（MJPEGストリーミング対応）
- タップ、スワイプ、ジェスチャー操作
- ハードウェアボタン制御
- アプリ管理（起動、終了、インストール）

**アーキテクチャ**:
- バイナリ形式で配布（`@mobilenext/mobilecli` npmパッケージ）
- JSON-RPCサーバーモード: `mobilecli server start --listen localhost:12000`
- コマンドラインモード: 直接コマンド実行

### 2. mobile-mcp
**リポジトリ**: https://github.com/mobile-next/mobile-mcp

**役割**:
- Model Context Protocol (MCP) サーバー実装
- AIエージェント（Claude、Cursor、Gemini等）がモバイルデバイスを操作できるようにする
- mobilecliを内部で使用

**主要機能**:
- **デバイス管理**: デバイス一覧、画面サイズ取得、向き変更
- **アプリ管理**: アプリ一覧、起動、終了、インストール、アンインストール
- **画面操作**: スクリーンショット、要素一覧、タップ、スワイプ、ロングプレス
- **入力・ナビゲーション**: テキスト入力、ボタン操作、URL開く

**MCPツール例**:
```typescript
// デバイス管理
mobile_list_available_devices()
mobile_get_screen_size()
mobile_set_orientation()

// アプリ管理
mobile_list_apps()
mobile_launch_app()
mobile_install_app()

// 画面操作
mobile_take_screenshot()
mobile_click_on_screen_at_coordinates()
mobile_swipe_on_screen()

// 入力
mobile_type_keys()
mobile_press_button()
```

**インストール方法**:
```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "npx",
      "args": ["-y", "@mobilenext/mobile-mcp@latest"]
    }
  }
}
```

**ライセンス**: Apache-2.0

### 3. mobiledeck
**リポジトリ**: https://github.com/mobile-next/mobiledeck

**役割**:
- VSCode拡張機能としてIDE内に統合
- 視覚的なデバイスプレビューと操作
- mobilecliを内部で使用

**主要機能**:
- サイドバーにデバイスリスト表示
- リアルタイムスクリーンミラーリング（MJPEG）
- マルチタッチ・ジェスチャー制御
- ハードウェアボタン制御

**ライセンス**: AGPL-3.0

## エコシステムの関係性

```
┌─────────────────┐
│   AI Agent      │
│ (Claude/Cursor) │
└────────┬────────┘
         │ MCP Protocol
         │
┌────────▼────────┐
│   mobile-mcp    │ ← MCP Server (Apache-2.0)
│  (MCP Server)   │
└────────┬────────┘
         │ Uses
         │
┌────────▼────────┐
│   mobilecli     │ ← Core Engine (JSON-RPC Server)
│  (CLI Tool)     │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
┌───▼───┐ ┌───▼────┐
│ iOS   │ │Android │
│Device │ │Device  │
└───────┘ └────────┘

┌─────────────────┐
│   VSCode IDE    │
└────────┬────────┘
         │ Extension API
         │
┌────────▼────────┐
│   mobiledeck    │ ← VSCode Extension (AGPL-3.0)
│  (Extension)    │
└────────┬────────┘
         │ Uses
         │
┌────────▼────────┐
│   mobilecli     │ ← Same Core Engine
│  (CLI Tool)     │
└─────────────────┘
```

## 現在のプロジェクトへの統合オプション

### オプション1: mobilecliのみを統合（推奨）

**メリット**:
- ✅ 実機デバイスサポートが追加される
- ✅ 統一されたAPIでデバイス操作が可能
- ✅ ライセンスが明確（mobilecliのライセンスを確認）
- ✅ MCPやVSCode拡張機能に依存しない

**実装方法**:
1. `@mobilenext/mobilecli` を依存関係に追加
2. `MobileCliServer` クラスを実装（mobiledeckを参考）
3. JSON-RPCクライアントでデバイス操作
4. MJPEGストリーミングを実装

**コード例**:
```typescript
// mobilecliサーバーを起動
const mobilecliPath = await findMobilecliPath();
const server = spawn(mobilecliPath, [
  'server', 'start',
  '--cors',
  '--listen', `localhost:${port}`
]);

// JSON-RPCクライアントでデバイス操作
const response = await fetch(`http://localhost:${port}/rpc`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    method: 'devices',
    params: { includeOffline: false },
    jsonrpc: '2.0',
    id: 1
  })
});

// MJPEGストリーミング
const streamResponse = await fetch(`http://localhost:${port}/rpc`, {
  method: 'POST',
  body: JSON.stringify({
    method: 'screencapture',
    params: { format: 'mjpeg', deviceId },
    jsonrpc: '2.0',
    id: 1
  })
});
```

### オプション2: mobile-mcpを統合（AIエージェント連携が必要な場合）

**メリット**:
- ✅ AIエージェントが自動的にデバイス操作できる
- ✅ 高度な自動化ワークフローが可能
- ✅ Apache-2.0ライセンス（商用利用可能）

**デメリット**:
- ⚠️ MCPプロトコルの理解が必要
- ⚠️ AIエージェント環境のセットアップが必要
- ⚠️ 直接的な統合ではなく、MCP経由の間接的な統合

**使用ケース**:
- AIエージェントによる自動テスト
- 自然言語でのデバイス操作
- 複雑なワークフローの自動化

### オプション3: mobiledeckのUI/UXを参考

**メリット**:
- ✅ 既存アーキテクチャを維持
- ✅ 段階的な改善が可能
- ✅ ライセンス問題を回避

**参考にできる点**:
- MJPEGストリーミングの実装
- デバイスリストのUI
- ジェスチャー制御のUI
- デバイススキンの表示

## 統合戦略の比較

| オプション | 実機サポート | 実装難易度 | ライセンス | 推奨度 |
|-----------|------------|-----------|---------|--------|
| mobilecli統合 | ✅ | 中 | 要確認 | ⭐⭐⭐⭐⭐ |
| mobile-mcp統合 | ✅ | 高 | Apache-2.0 | ⭐⭐⭐ |
| UI/UX参考 | ❌ | 低 | 問題なし | ⭐⭐⭐⭐ |

## 推奨実装アプローチ

### フェーズ1: mobilecliの評価と統合

1. **mobilecliの動作確認**
   ```bash
   npx @mobilenext/mobilecli --version
   npx @mobilenext/mobilecli devices
   ```

2. **JSON-RPCサーバーの起動テスト**
   ```bash
   npx @mobilenext/mobilecli server start --listen localhost:12000
   ```

3. **統合実装**
   - `MobileCliServer` クラスの実装
   - JSON-RPCクライアントの実装
   - MJPEGストリーミングの実装
   - 既存の `SimulatorManager` と並行して動作可能にする

### フェーズ2: 段階的な移行

1. **オプション機能として実装**
   - 設定でmobilecliを使用するか選択可能にする
   - 既存の `simctl`/`adb` 直接実行と並行運用

2. **機能の段階的置き換え**
   - デバイスリスト取得 → mobilecli経由
   - スクリーンキャプチャ → MJPEGストリーミング
   - デバイス操作 → JSON-RPC経由

3. **実機サポートの追加**
   - mobilecliが実機を検出・操作できることを確認
   - UIで実機とシミュレータを区別表示

### フェーズ3: 高度な機能（オプション）

1. **AIエージェント連携**（必要に応じて）
   - mobile-mcpを統合
   - MCPプロトコルの理解と実装

2. **パフォーマンス最適化**
   - ストリーミング品質の調整
   - レイテンシの最適化

## ライセンス確認事項

### mobilecli
- **ライセンス**: 要確認（リポジトリを確認する必要がある）
- **配布方法**: npmパッケージ（`@mobilenext/mobilecli`）

### mobile-mcp
- **ライセンス**: Apache-2.0 ✅
- **商用利用**: 可能

### mobiledeck
- **ライセンス**: AGPL-3.0 ⚠️
- **商用利用**: ソースコード公開が必要

## 実装例

### mobilecliサーバーの起動と管理

```typescript
import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';

export class MobileCliServer {
  private serverProcess: ChildProcess | null = null;
  private serverPort: number = 12000;

  async start(): Promise<void> {
    if (this.serverProcess) {
      return; // 既に起動中
    }

    const mobilecliPath = await this.findMobilecliPath();

    this.serverProcess = spawn(mobilecliPath, [
      'server', 'start',
      '--cors',
      '--listen', `localhost:${this.serverPort}`
    ]);

    // サーバーの準備完了を待つ
    await this.waitForServerReady();
  }

  async stop(): Promise<void> {
    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = null;
    }
  }

  private async findMobilecliPath(): Promise<string> {
    // npx経由で実行するか、ローカルにインストールされたバイナリを使用
    return 'npx'; // または実際のパス
  }

  private async waitForServerReady(): Promise<void> {
    // ヘルスチェック実装
  }
}
```

### JSON-RPCクライアント

```typescript
export class JsonRpcClient {
  constructor(private baseUrl: string) {}

  async sendRequest(method: string, params: any): Promise<any> {
    const response = await fetch(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: Date.now()
      })
    });

    const result = await response.json();
    if (result.error) {
      throw new Error(result.error.message);
    }
    return result.result;
  }
}
```

### MJPEGストリーミング

```typescript
export class MjpegStreamer {
  async startStream(deviceId: string, onFrame: (bitmap: ImageBitmap) => void) {
    const response = await fetch(`http://localhost:12000/rpc`, {
      method: 'POST',
      body: JSON.stringify({
        method: 'screencapture',
        params: { format: 'mjpeg', deviceId },
        jsonrpc: '2.0',
        id: 1
      })
    });

    const reader = response.body?.getReader();
    if (!reader) return;

    // MJPEGストリームの処理
    // (mobiledeckのMjpegStream.tsを参考)
  }
}
```

## 結論

**最適な統合アプローチ**:

1. **短期**: mobilecliを統合して実機サポートを追加
   - 既存機能を維持しつつ、オプションとして追加
   - MJPEGストリーミングでパフォーマンス向上

2. **中期**: 段階的にmobilecli経由に移行
   - デバイス操作を統一
   - 実機とシミュレータの両方をサポート

3. **長期**（オプション）: AIエージェント連携
   - mobile-mcpを統合して自動化機能を追加
   - 高度なワークフロー自動化

**次のステップ**:
1. mobilecliのライセンスを確認
2. mobilecliの動作テスト
3. プロトタイプ実装
4. 既存機能との統合

