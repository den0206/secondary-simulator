import * as vscode from 'vscode';
import {DeviceStatusBar} from './ui/DeviceStatusBar';
import {Logger} from './utils/Logger';
import {SimulatorWebviewProvider} from './webview/SimulatorWebviewProvider';

let provider: SimulatorWebviewProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  Logger.initialize();
  Logger.info('Secondary Simulator extension activated');

  const statusBar = new DeviceStatusBar();
  provider = new SimulatorWebviewProvider(context.extensionUri, (status) =>
    statusBar.update(status)
  );

  const webviewProvider = vscode.window.registerWebviewViewProvider(
    SimulatorWebviewProvider.viewType,
    provider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }
  );

  const commands = [
    vscode.commands.registerCommand('simulator.selectDevice', async () => {
      await vscode.commands.executeCommand('simulatorView.focus');
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
        title: 'Secondary Simulator: デバイスで開く URL',
        placeHolder: 'myapp://path/to/screen または https://example.com',
        validateInput: (value) =>
          value.trim() ? undefined : 'URL を入力してください',
      });
      if (!url) return;
      await provider.openUrl(url.trim());
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

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('secondarySimulator')) {
      // ログレベルを先に取り込む（この直後の Configuration changed から効かせる）
      Logger.refreshLevel();
      Logger.info('Configuration changed');
      if (provider) {
        provider.onConfigurationChanged();
      }
    }
  });

  context.subscriptions.push(
    webviewProvider,
    ...commands,
    configListener,
    statusBar,
    {
      dispose: () => {
        if (provider) {
          provider.dispose();
          provider = null;
        }
        Logger.dispose();
      },
    }
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
      'Secondary Simulator: デバイスが見つかりません。シミュレータ／エミュレータを起動してから再試行してください。'
    );
    return;
  }

  const current = p.getCurrentDeviceId();
  const items = devices.map((d) => ({
    label: `${d.id === current ? '$(check) ' : ''}${d.name}`,
    // 起動していないデバイスは選んでも繋がらないので、その場で分かるようにする
    description: [d.platform, d.runtime, d.state].filter(Boolean).join(' · '),
    detail: d.state === 'Booted' ? undefined : '起動していません（選ぶと起動できます）',
    deviceId: d.id,
    name: d.name,
    booted: d.state === 'Booted',
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Secondary Simulator: 接続するデバイス',
    placeHolder: '起動中のデバイスを選ぶと接続します（停止中はここから起動できます）',
    matchOnDescription: true,
  });
  if (!picked) return;

  if (!picked.booted) {
    // 以前はここで終わっていた。シミュレータを自分で立ち上げに行かずに済ませる。
    const answer = await vscode.window.showInformationMessage(
      `${picked.name} は起動していません。起動しますか？`,
      '起動して接続',
      'キャンセル'
    );
    if (answer !== '起動して接続') return;
    await p.bootAndConnect(picked.deviceId);
    return;
  }
  await p.selectDevice(picked.deviceId);
}

export function deactivate(): void {
  if (provider) {
    provider.dispose();
    provider = null;
  }
  Logger.info('Secondary Simulator extension deactivated');
  Logger.dispose();
}
