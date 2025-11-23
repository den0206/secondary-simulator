import * as vscode from 'vscode';
import { SimulatorWebviewProvider } from './webview/SimulatorWebviewProvider';
import { Logger } from './utils/Logger';

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
        retainContextWhenHidden: true
      }
    }
  );

  const commands = [
    vscode.commands.registerCommand('simulator.selectDevice', () => {
      vscode.commands.executeCommand('simulatorView.focus');
    }),

    vscode.commands.registerCommand('simulator.startCapture', () => {
      Logger.info('Start capture command executed');
    }),

    vscode.commands.registerCommand('simulator.stopCapture', () => {
      Logger.info('Stop capture command executed');
    }),

    vscode.commands.registerCommand('simulator.takeScreenshot', () => {
      Logger.info('Take screenshot command executed');
    }),

    vscode.commands.registerCommand('simulator.home', () => {
      Logger.info('Home command executed');
    }),

    vscode.commands.registerCommand('simulator.back', () => {
      Logger.info('Back command executed');
    }),

    vscode.commands.registerCommand('simulator.refresh', async () => {
      if (provider) {
        await provider.refreshDevices();
      }
    })
  ];

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('secondarySimulator')) {
      Logger.info('Configuration changed');
    }
  });

  context.subscriptions.push(
    webviewProvider,
    ...commands,
    configListener,
    {
      dispose: () => {
        if (provider) {
          provider.dispose();
          provider = null;
        }
        Logger.dispose();
      }
    }
  );
}

export function deactivate(): void {
  if (provider) {
    provider.dispose();
    provider = null;
  }
  Logger.info('Secondary Simulator extension deactivated');
  Logger.dispose();
}
