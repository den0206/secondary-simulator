import * as vscode from 'vscode';
import {StatusStrings} from '../ui/DeviceStatusBar';

/**
 * 翻訳が要る文言のうち、**vscode に触れない場所へ渡すもの**をここで作る。
 *
 * - VS Code の UI（通知・QuickPick・設定画面）は各呼び出し側で `vscode.l10n.t()` を直に使う。
 *   原文がその場に見えている方が読みやすいため。
 * - 一方、`renderStatus`（純粋関数）と **webview**（別プロセスで `vscode` を持たない）へは
 *   出来上がった文字列を渡す必要がある。その組み立てがここ。
 *
 * 翻訳は `l10n/bundle.l10n.<locale>.json`。原文（＝キー）は英語で、
 * 既定言語では bundle が無くてもそのまま出る。
 *
 * ログは対象外 — 開発者向けの診断であり、UI ではない。
 */

/** ステータスバーと webview フッターが共有する入力経路のラベル。 */
export function statusStrings(): StatusStrings {
  return {
    hid: vscode.l10n.t('Fast mode (HID)'),
    wda: vscode.l10n.t('Compatible mode (WDA)'),
    connecting: vscode.l10n.t('Secondary Simulator: connecting to {0}'),
    connected: vscode.l10n.t('Secondary Simulator: connected to {0} ({1})'),
    hidDetail: vscode.l10n.t('Touch and keys are injected directly over HID.'),
    wdaDetail: vscode.l10n.t(
      'Through mobilecli/WDA. HID is unavailable or was demoted.'
    ),
  };
}

/**
 * webview へ渡す文言。**HTML 生成時に JSON として埋め込む**ので、
 * 表示前に翻訳が揃う（後から差し替えると一瞬英語が見える）。
 *
 * キーは webview 側の `data-i18n` 属性と `t()` の引数に対応する。
 * 増やしたら `media/webview/main.js` と `test/localization.test.js` も揃える。
 */
export function webviewStrings(): Record<string, string> {
  return {
    // ツールバー
    selectDevice: vscode.l10n.t('Select Device…'),
    refresh: vscode.l10n.t('Refresh the device list'),
    lampConnected: vscode.l10n.t('Connected'),
    lampDisconnected: vscode.l10n.t('Disconnected'),

    // デバイス一覧
    groupIos: vscode.l10n.t('iOS'),
    groupAndroid: vscode.l10n.t('Android'),
    stopped: vscode.l10n.t('stopped'),

    // 操作ボタン
    home: vscode.l10n.t('Home'),
    back: vscode.l10n.t('Back'),
    shot: vscode.l10n.t('Shot'),
    shotTitle: vscode.l10n.t('Save a screenshot'),
    recordStart: vscode.l10n.t('● Rec'),
    recordStop: vscode.l10n.t('■ Stop'),
    recordTitle: vscode.l10n.t('Record the screen to a video file'),
    trailOn: vscode.l10n.t('Trail ON'),
    trailOff: vscode.l10n.t('Trail OFF'),
    trailTitle: vscode.l10n.t('Show tap ripples and drag trails'),
    autoOn: vscode.l10n.t('Auto ON'),
    autoOff: vscode.l10n.t('Auto OFF'),
    autoTitle: vscode.l10n.t('Connect automatically to a running device'),
    disconnect: vscode.l10n.t('Disconnect'),

    // オーバーレイ
    selectToStart: vscode.l10n.t('Select a device to start'),
    searching: vscode.l10n.t('Searching…'),
    connecting: vscode.l10n.t('Connecting…'),
    // {0} はデバイス名
    connectingTo: vscode.l10n.t('Connecting… {0}'),
    disconnected: vscode.l10n.t('Disconnected — pick a device to reconnect'),
    streamFailed: vscode.l10n.t('Cannot connect to the stream'),
    retry: vscode.l10n.t('Retry'),
    showLogs: vscode.l10n.t('Show Logs'),

    // フッター
    measuring: vscode.l10n.t('Measuring…'),
    modeTitle: vscode.l10n.t(
      'Input path. HID injects straight into the device (fast); WDA goes through mobilecli (compatible).'
    ),
    statsTitle: vscode.l10n.t(
      'Updated every 30 seconds. The extension host process is shared with other extensions. The extension directory is the size of the bundled files and does not grow at runtime (this extension keeps no persistent storage). WebDriverAgent installed by mobilecli is not included.'
    ),
    video: vscode.l10n.t('Video'),
    direct: vscode.l10n.t('direct'),
    host: vscode.l10n.t('Host'),
    heap: vscode.l10n.t('heap'),
    children: vscode.l10n.t('Child processes'),
    extension: vscode.l10n.t('Extension'),
  };
}
