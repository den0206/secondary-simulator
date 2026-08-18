/**
 * 取り込みの実効レート。フッターへ出して「同期が効いているか」を見えるようにする。
 *
 * この拡張はメモリを測れる状態を保っているのに、**同期そのものは測れていなかった**
 * （docs/sync-enhancement.md §2.13）。改善を入れる前に、効果を確かめる手段を用意する。
 *
 * vscode に触らない純粋関数なので単体テストできる（`DeviceStatusBar.renderStatus` と同じ方針）。
 */
export interface CaptureRate {
  /** 拡張ホストが受け取ったフレーム数 / 秒。画面が変わらない間は 0 に近づく（正常）。 */
  fps: number;
  /**
   * webview へ渡したバイト数 / 秒（KB）。**base64 の文字数**で数える。
   * JPEG 本体はこの 3/4 で、実際に転送しているのは base64 の方だから。
   */
  kbps: number;
}

/** 実際にサイドカーへ送る取り込み設定。 */
export interface EffectiveCapture {
  fps: number;
  maxWidth: number;
  quality: number;
}

/** 取り込みの粗さを決める外部条件。 */
export interface CaptureContext {
  /** 表示中の実ピクセル幅（CSS 幅 × devicePixelRatio）。未報告なら null。 */
  viewportWidth: number | null;
  /** 指が触れている最中か。 */
  interacting: boolean;
}

/** 操作中でも超えない fps。これ以上は端末の更新レートを超えるので意味が無い。 */
const MAX_FPS = 60;
/** 送る最小幅。これ以下だと何が映っているか分からない。 */
const MIN_WIDTH = 160;

/**
 * 設定値・表示幅・操作状態から、実際に送る取り込み設定を決める。
 *
 * 方針（docs/sync-enhancement.md §3.4）:
 * - **設定値は上限として扱う。** 表示が狭いときに要らない画素を送らない。
 *   広げたときは設定値で頭打ちになる（帯域が黙って増えないため。鮮明にしたい人は
 *   `captureMaxWidth` を上げる）。
 * - **操作中だけ fps を上げる。** 追従が要るのはドラッグ中だけで、静止中に
 *   同じレートで回すのはエンコードの無駄。上げ幅は 2 倍・上限 60fps。
 *   **通常時は設定値のまま**なので、今より遅くなる状況は無い。
 */
export function effectiveCaptureConfig(
  config: EffectiveCapture,
  context: CaptureContext
): EffectiveCapture {
  const base = clampFps(config.fps);
  const fps = context.interacting ? Math.min(MAX_FPS, base * 2) : base;

  const limit = Math.max(MIN_WIDTH, Math.round(config.maxWidth) || MIN_WIDTH);
  const wanted =
    context.viewportWidth && context.viewportWidth > 0
      ? Math.round(context.viewportWidth)
      : limit;
  const maxWidth = Math.min(limit, Math.max(MIN_WIDTH, wanted));

  return {fps, maxWidth, quality: config.quality};
}

function clampFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 1;
  return Math.min(MAX_FPS, Math.max(1, Math.round(fps)));
}

/**
 * 設定変更で取り込みをどう扱うか。
 *
 * - `recreate`: 経路そのものが変わる（取り込み元・直結・駆動方法）。
 *   `captureConfig` では足りず、インスタンスを作り直す。
 * - `tune`: fps / 幅 / JPEG 品質。張り直さず `captureConfig` で差し替える。
 * - `none`: 取り込みと無関係（Auto ボタンで画面を切らない）。
 *
 * イベントを渡さずに呼ばれた場合は recreate に倒す（従来どおり）。
 */
const TUNE_KEYS = [
  'secondarySimulator.captureFps',
  'secondarySimulator.captureMaxWidth',
  'secondarySimulator.streamQuality',
] as const;

const RECREATE_KEYS = [
  'secondarySimulator.captureSource',
  'secondarySimulator.directStream',
  'secondarySimulator.captureMode',
  'secondarySimulator.streamScale',
] as const;

export function captureConfigAction(
  affects?: (section: string) => boolean
): 'recreate' | 'tune' | 'none' {
  if (!affects) return 'recreate';
  if (RECREATE_KEYS.some((key) => affects(key))) return 'recreate';
  if (TUNE_KEYS.some((key) => affects(key))) return 'tune';
  return 'none';
}

/**
 * 集計期間の合計から毎秒あたりへ直す。
 *
 * @param frames 期間中に受け取ったフレーム数
 * @param base64Length 同 base64 の合計文字数
 * @param elapsedMs 期間の長さ。0 以下なら測れていないので 0 を返す
 */
export function captureRate(
  frames: number,
  base64Length: number,
  elapsedMs: number
): CaptureRate {
  if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs)) {
    return {fps: 0, kbps: 0};
  }
  const seconds = elapsedMs / 1000;
  return {
    // 0.1 刻み。静止画面では 0.x fps になるので整数へ丸めない
    fps: Math.round((frames / seconds) * 10) / 10,
    kbps: Math.round(base64Length / 1024 / seconds),
  };
}
