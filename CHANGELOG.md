# Changelog

## [Unreleased]

- iOS Simulator への HID 直接注入（`native/simhid-server`）と WDA へのフォールバック
- MJPEG 直結ストリーム表示（`secondarySimulator.directStream`）と帯域設定
- Pointer Events の生配信によるドラッグ/ピンチ追従
- サイドバーに接続ランプ、Refresh、Trail / Auto トグル、リソース使用量を表示
- 起動中デバイスへの自動接続（`secondarySimulator.autoConnect`、Disconnect で OFF）
- アクティビティバー名を Secondary Simulator に変更
- CI（型チェック・テスト・VSIX パッケージ）とリリース自動化を追加
