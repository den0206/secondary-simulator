import * as vscode from 'vscode';
import {Logger} from './utils/Logger';
import {SimulatorWebviewProvider} from './webview/SimulatorWebviewProvider';

let provider: SimulatorWebviewProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  Logger.initialize();
  Logger.info('Secondary Simulator extension activated');

  provider = new SimulatorWebviewProvider(context.extensionUri);

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
      Logger.info('Configuration changed');
      if (provider) {
        provider.onConfigurationChanged();
      }
    }
  });

  context.subscriptions.push(webviewProvider, ...commands, configListener, {
    dispose: () => {
      if (provider) {
        provider.dispose();
        provider = null;
      }
      Logger.dispose();
    },
  });
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
    detail: d.state === 'Booted' ? undefined : '起動していません',
    deviceId: d.id,
    booted: d.state === 'Booted',
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Secondary Simulator: 接続するデバイス',
    placeHolder: '起動中のデバイスを選ぶと接続します',
    matchOnDescription: true,
  });
  if (!picked) return;

  if (!picked.booted) {
    void vscode.window.showWarningMessage(
      `${picked.label} は起動していません。先にシミュレータ／エミュレータを起動してください。`
    );
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
