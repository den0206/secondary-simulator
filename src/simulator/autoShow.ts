/**
 * デバッグ開始でサイドバーを自動表示するかを決める。
 *
 * VS Code に「ビルド」というイベントは無く、拾えるのはデバッグセッションの開始
 * （`vscode.debug.onDidStartDebugSession`）だけ。ターミナルで `flutter run` を直接
 * 叩いた場合は届かない。
 *
 * デバッグの種別で絞るのは、この拡張が Flutter 専用ではないため。絞らないと
 * Node や Go のデバッグでもサイドバーが飛び出してくる。
 */

/**
 * 既定で反応するデバッグの種別（launch.json の `type`）。
 *
 * - `dart`: Dart / Flutter。**iOS でも Android でも同じ種別**で、ターゲットでは変わらない。
 * - `reactnative` / `reactnativedirect`: React Native。
 * - `android`: ネイティブ Android（Java / Kotlin）。
 * - `sweetpad-lldb`: VS Code から Xcode プロジェクトを回す場合の iOS。
 *
 * Swift（`swift`）は macOS / Linux の実行が主で、パッケージのテスト実行でも
 * 出てきてしまうため既定に入れない。
 */
export const DEFAULT_AUTO_SHOW_DEBUG_TYPES = [
  'dart',
  'reactnative',
  'reactnativedirect',
  'android',
  'sweetpad-lldb',
];

export interface AutoShowState {
  /** `secondarySimulator.autoShow` */
  enabled: boolean;
  /** `secondarySimulator.autoShowDebugTypes`。空なら種別で絞らない。 */
  types: string[];
  /** ビューが見えているか。見えているなら触らない。 */
  visible: boolean;
}

/** デバッグ開始時にビューを出すべきか。 */
export function shouldAutoShow(
  sessionType: string,
  state: AutoShowState
): boolean {
  if (!state.enabled) return false;
  // 既に見えているなら何もしない（フォーカスも動かさない）
  if (state.visible) return false;
  const types = state.types
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (types.length === 0) return true;
  return types.includes(sessionType.trim().toLowerCase());
}
