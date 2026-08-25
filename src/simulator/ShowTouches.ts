import {AdbRunner, runnerFor} from '../input/Adb';
import {Logger} from '../utils/Logger';

/**
 * 録画中だけ Android の「タップを表示」を立てる。
 *
 * 録画は端末側で完結する（Android は `adb shell screenrecord`）。**拡張が webview に
 * 描いているリップルと軌跡は端末のフレームバッファに存在しない**ので、そのままでは
 * 動画にどこを触ったかが残らない。`show_touches` はシステムがディスプレイへ直接
 * 描くため、`screenrecord` にそのまま入る。
 *
 * mobilecli にこの設定を触る口は無い（`device.settings.apply` は `animations` だけ）。
 * そのため adb を直接使うが、入口は {@link ../input/Adb} に集約している。
 *
 * **必ず元の値へ戻す。** 普段から ON にしている利用者の設定を勝手に落とさないため、
 * 立てる前に読んで、その値を返す。呼び手はそれを持っておいて {@link restore} へ渡す。
 */

/** 設定の置き場。`system` 名前空間（`global` ではない）。 */
const NAMESPACE = 'system';
const KEY = 'show_touches';

/**
 * `settings get system show_touches` の出力を、`put` でそのまま使える値に直す。
 *
 * 一度も触っていない端末は `null` を返す。Android の既定は「表示しない」なので
 * `0` に寄せる（`null` を書き戻すと文字列 "null" が入って設定が壊れる）。
 */
export function normalizeSetting(stdout: string): string {
  const value = stdout.trim();
  if (value === '1') return '1';
  return '0';
}

/**
 * 「タップを表示」を立てる。
 *
 * @param runner テスト用の差し替え口。省略時は adb を探して作る
 * @returns 復元すべき元の値。**復元が要らないときは `null`** — adb が使えない、
 *   失敗した、あるいは既に有効だった場合。**例外は投げない**（録画自体は続ける）
 */
export async function enable(
  deviceId: string,
  runner?: AdbRunner
): Promise<string | null> {
  const run = runner ?? (await runnerFor(deviceId));
  if (!run) {
    Logger.info('adb が使えないので「タップを表示」は設定しない');
    return null;
  }
  try {
    const previous = normalizeSetting(
      await run(['shell', 'settings', 'get', NAMESPACE, KEY])
    );
    if (previous === '1') {
      // 既に立っている。触らないので戻す必要も無い。
      Logger.debug('「タップを表示」は既に有効');
      return null;
    }
    await run(['shell', 'settings', 'put', NAMESPACE, KEY, '1']);
    Logger.info('録画のあいだ「タップを表示」を有効にした');
    return previous;
  } catch (error) {
    Logger.warn(
      `「タップを表示」を設定できなかった: ${(error as Error).message}`
    );
    return null;
  }
}

/**
 * {@link enable} が返した値へ戻す。
 *
 * 停止・切断・破棄・上限のどの経路から来ても呼ばれる。ここで失敗すると利用者の
 * 端末に設定が残るので、**理由を残す**（黙って諦めない）。
 */
export async function restore(
  deviceId: string,
  previous: string,
  runner?: AdbRunner
): Promise<void> {
  const run = runner ?? (await runnerFor(deviceId));
  if (!run) {
    Logger.warn('adb が使えず「タップを表示」を戻せなかった');
    return;
  }
  try {
    await run(['shell', 'settings', 'put', NAMESPACE, KEY, previous]);
    Logger.info(`「タップを表示」を ${previous} へ戻した`);
  } catch (error) {
    Logger.warn(
      `「タップを表示」を戻せなかった（端末に残る）: ${(error as Error).message}`
    );
  }
}
