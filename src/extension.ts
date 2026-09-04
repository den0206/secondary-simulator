import * as vscode from 'vscode';
import {
  DEFAULT_AUTO_SHOW_DEBUG_TYPES,
  shouldAutoShow,
} from './simulator/autoShow';
import {DeviceStatusBar} from './ui/DeviceStatusBar';
import {statusStrings} from './utils/Strings';
import {Logger} from './utils/Logger';
import {SimulatorWebviewProvider} from './webview/SimulatorWebviewProvider';

let provider: SimulatorWebviewProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  Logger.initialize();
  Logger.info('Secondary Simulator extension activated');

  const statusBar = new DeviceStatusBar(statusStrings());
  provider = new SimulatorWebviewProvider(context.extensionUri, (status) =>
    statusBar.update(status)
  );

  // `retainContextWhenHidden` は付けない。付けると非表示のあいだ webview の
  // iframe を丸ごと抱え続ける（VS Code 自身が「メモリを食うので避けよ」としている）。
  // この拡張は畳んだ時点で取り込みも録画も止めており、作り直された webview へは
  // `init` を合図に状態を送り直す（`SimulatorWebviewProvider.restoreWebviewState`）。
  // 抱えて守れるのは復帰の速さだけなので、CLAUDE.md のメモリ方針を優先する。
  const webviewProvider = vscode.window.registerWebviewViewProvider(
    SimulatorWebviewProvider.viewType,
    provider
  );

  const commands = [
    vscode.commands.registerCommand('simulator.selectDevice', async () => {
      await vscode.commands.executeCommand(
        `${SimulatorWebviewProvider.viewType}.focus`
      );
      if (!provider) return;
      await pickDevice(provider);
    }),

    vscode.commands.registerCommand('simulator.screenshot', async () => {
      if (provider) {
        await provider.saveScreenshot();
      }
    }),

    vscode.commands.registerCommand('simulator.openUrl', async () => {
      if (!provider) return;
      const url = await vscode.window.showInputBox({
        title: vscode.l10n.t('Secondary Simulator: URL to open on the device'),
        placeHolder: vscode.l10n.t(
          'myapp://path/to/screen or https://example.com'
        ),
        validateInput: (value) =>
          value.trim() ? undefined : vscode.l10n.t('Enter a URL.'),
      });
      if (!url) return;
      await provider.openUrl(url.trim());
    }),

    vscode.commands.registerCommand('simulator.record', async () => {
      if (provider) {
        await provider.toggleRecording();
      }
    }),

    vscode.commands.registerCommand('simulator.showLogs', () => {
      Logger.show();
    }),

    vscode.commands.registerCommand('simulator.clearLogs', () => {
      Logger.clear();
      Logger.info('ログを消去しました');
    }),

    vscode.commands.registerCommand('simulator.home', async () => {
      if (provider) {
        await provider.pressHome();
      }
    }),

    vscode.commands.registerCommand('simulator.back', async () => {
      if (provider) {
        await provider.pressBack();
      }
    }),

    vscode.commands.registerCommand('simulator.refresh', async () => {
      if (provider) {
        await provider.refreshDevices();
      }
    }),
  ];

  // ビルド（デバッグ開始）でサイドバーを出す。表示中なら何もしない。
  const debugListener = vscode.debug.onDidStartDebugSession((session) => {
    const config = vscode.workspace.getConfiguration('secondarySimulator');
    const show = shouldAutoShow(session.type, {
      enabled: config.get<boolean>('autoShow', true),
      types: config.get<string[]>(
        'autoShowDebugTypes',
        DEFAULT_AUTO_SHOW_DEBUG_TYPES
      ),
      visible: provider?.isViewVisible() === true,
    });
    if (!show) return;
    Logger.info(`デバッグ開始（${session.type}）を検知したのでビューを表示する`);
    // preserveFocus を落とすとキーボードフォーカスまで奪われ、以後の打鍵が端末へ流れる
    void vscode.commands.executeCommand(
      `${SimulatorWebviewProvider.viewType}.focus`,
      {preserveFocus: true}
    );
  });

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('secondarySimulator')) {
      // ログレベルを先に取り込む（この直後の Configuration changed から効かせる）
      Logger.refreshLevel();
      Logger.info('Configuration changed');
      if (provider) {
        // 何が変わったかを渡す。取り込みに関係ない設定で画面を切らないため
        provider.onConfigurationChanged(e);
      }
    }
  });

  context.subscriptions.push(
    webviewProvider,
    ...commands,
    debugListener,
    configListener,
    // **provider を statusBar より先に捨てる。** provider.dispose() は最後に
    // 「未接続」を流すので、順序が逆だと破棄済みの StatusBarItem を触ることになる。
    // ここは `deactivate` が済んだ後の保険（Disposable は Promise を待てないので、
    // 録画の書き終わりを待つ経路は `deactivate` 側に置く）。
    {
      dispose: () => {
        if (provider) {
          void provider.dispose();
          provider = null;
        }
      },
    },
    statusBar,
    // ログは全部の後始末が済んでから閉じる（dispose 中のログを捨てない）
    {dispose: () => Logger.dispose()}
  );
}

/**
 * コマンドパレットからデバイスを選ぶ。以前はビューへフォーカスするだけだったので、
 * 「Select Device」を実行しても選べなかった。
 */
async function pickDevice(p: SimulatorWebviewProvider): Promise<void> {
  await p.refreshDevices();
  const devices = p.getDevices();
  if (devices.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Secondary Simulator: No devices found. Start a simulator or emulator and try again.'
      )
    );
    return;
  }

  const current = p.getCurrentDeviceId();
  const items = devices.map((d) => ({
    label: `${d.id === current ? '$(check) ' : ''}${d.name}`,
    // 起動していないデバイスは選んでも繋がらないので、その場で分かるようにする
    description: [d.platform, d.runtime, d.state].filter(Boolean).join(' · '),
    detail:
      d.state === 'Booted'
        ? undefined
        : vscode.l10n.t('Not running (select it to boot)'),
    deviceId: d.id,
    name: d.name,
    booted: d.state === 'Booted',
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Secondary Simulator: Device to connect to'),
    placeHolder: vscode.l10n.t(
      'Pick a running device to connect. Stopped devices can be booted from here.'
    ),
    matchOnDescription: true,
  });
  if (!picked) return;

  if (!picked.booted) {
    // 以前はここで終わっていた。シミュレータを自分で立ち上げに行かずに済ませる。
    const boot = vscode.l10n.t('Boot and connect');
    const answer = await vscode.window.showInformationMessage(
      vscode.l10n.t('{0} is not running. Boot it?', picked.name),
      boot,
      vscode.l10n.t('Cancel')
    );
    if (answer !== boot) return;
    await p.bootAndConnect(picked.deviceId);
    return;
  }
  await p.selectDevice(picked.deviceId);
}

/**
 * **Promise を返す。** 録画中にウィンドウを閉じた場合、`provider.dispose()` は
 * webview に符号化を止めさせて最後のチャンク（mp4 の `moov`）を書き終えるまで待つ。
 * ここで待たないと、映像は入っているのに再生できないファイルが残る。
 *
 * `context.subscriptions` の Disposable は Promise を待てないので、待つ必要がある
 * 後始末はこちらに置く（VS Code は `deactivate` の Thenable を待つ）。
 * 待ちの上限は `SimulatorWebviewProvider.DISPOSE_STOP_BUDGET_MS` が持つ。
 */
export async function deactivate(): Promise<void> {
  if (provider) {
    await provider.dispose();
    provider = null;
  }
  Logger.info('Secondary Simulator extension deactivated');
  Logger.dispose();
}
