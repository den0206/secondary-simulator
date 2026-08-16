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
    vscode.commands.registerCommand('simulator.selectDevice', () => {
      vscode.commands.executeCommand('simulatorView.focus');
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

export function deactivate(): void {
  if (provider) {
    provider.dispose();
    provider = null;
  }
  Logger.info('Secondary Simulator extension deactivated');
  Logger.dispose();
}
