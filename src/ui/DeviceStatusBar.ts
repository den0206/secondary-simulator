import * as vscode from 'vscode';

/**
 * 接続状態。`backend` は入力経路（HID 直接注入か WDA 経由か）。
 * HID→WDA の降格は無音で起きるため、どちらで動いているかを見えるようにする。
 */
export type DeviceStatus =
  | {state: 'disconnected'}
  | {state: 'connecting'; name: string}
  | {state: 'connected'; name: string; backend: 'hid' | 'wda'};

export interface StatusView {
  /** ステータスバーの表示文字列。null なら隠す。 */
  text: string | null;
  tooltip: string;
  /** webview のフッターへ出す短いラベル。null なら出さない。 */
  mode: string | null;
}

/**
 * 表示に使う文言。**`renderStatus` を純粋関数のまま保つため、翻訳は外から渡す**
 * （`vscode.l10n` に触るとテストから呼べなくなる）。既定は英語。
 */
export interface StatusStrings {
  /** 入力経路の呼び名。webview のフッターとステータスバーで同じ言葉を使う。 */
  hid: string;
  wda: string;
  /** `{0}` にデバイス名が入る。 */
  connecting: string;
  connected: string;
  hidDetail: string;
  wdaDetail: string;
}

export const DEFAULT_STATUS_STRINGS: StatusStrings = {
  hid: 'Fast mode (HID)',
  wda: 'Compatible mode (WDA)',
  connecting: 'Secondary Simulator: connecting to {0}',
  connected: 'Secondary Simulator: connected to {0} ({1})',
  hidDetail: 'Touch and keys are injected directly over HID.',
  wdaDetail: 'Through mobilecli/WDA. HID is unavailable or was demoted.',
};

const fill = (template: string, ...args: string[]): string =>
  template.replace(/\{(\d)\}/g, (_, i) => args[Number(i)] ?? '');

/**
 * 表示文字列を組み立てる（vscode に触らない純粋関数。テストはここを見る）。
 *
 * 未接続のときは何も出さない。常駐する情報ではないので、繋がっている間だけ
 * ステータスバーに席を取る。
 */
export function renderStatus(
  status: DeviceStatus,
  strings: StatusStrings = DEFAULT_STATUS_STRINGS
): StatusView {
  switch (status.state) {
    case 'connecting':
      return {
        text: `$(sync~spin) ${status.name}`,
        tooltip: fill(strings.connecting, status.name),
        mode: null,
      };
    case 'connected': {
      const label = status.backend === 'hid' ? strings.hid : strings.wda;
      return {
        text: `$(device-mobile) ${status.name} · ${status.backend.toUpperCase()}`,
        tooltip:
          fill(strings.connected, status.name, label) +
          '\n' +
          (status.backend === 'hid' ? strings.hidDetail : strings.wdaDetail),
        mode: label,
      };
    }
    case 'disconnected':
      return {text: null, tooltip: '', mode: null};
  }
}

/**
 * 接続中のデバイスと入力経路をステータスバーに出す。
 *
 * 押すとデバイス選択（`simulator.selectDevice`）へ飛ぶ。
 */
export class DeviceStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly strings: StatusStrings;

  constructor(strings: StatusStrings = DEFAULT_STATUS_STRINGS) {
    this.strings = strings;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'simulator.selectDevice';
    this.item.name = 'Secondary Simulator';
  }

  update(status: DeviceStatus): void {
    const view = renderStatus(status, this.strings);
    if (view.text === null) {
      this.item.hide();
      return;
    }
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
