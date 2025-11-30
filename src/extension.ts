import * as vscode from 'vscode';
import {Logger} from './utils/Logger';
import {TempCleaner} from './utils/TempCleaner';
import {SimulatorWebviewProvider} from './webview/SimulatorWebviewProvider';

let provider: SimulatorWebviewProvider | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;
const CLEAN_INTERVAL_MS = 15 * 60 * 1000; // 15分間隔

export function activate(context: vscode.ExtensionContext): void {
  Logger.initialize();
  Logger.info('Secondary Simulator extension activated');

  // 旧版の一時ファイルが残っている可能性に備えクリーンアップ
  TempCleaner.cleanOnce();
  cleanupTimer = setInterval(() => {
    TempCleaner.cleanOnce();
  }, CLEAN_INTERVAL_MS);

  provider = new SimulatorWebviewProvider(context.extensionUri, context);

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

    vscode.commands.registerCommand('simulator.startCapture', () => {
      Logger.info('Start capture command executed');
    }),

    vscode.commands.registerCommand('simulator.stopCapture', () => {
      Logger.info('Stop capture command executed');
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
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
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
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  TempCleaner.cleanOnce();
  Logger.info('Secondary Simulator extension deactivated');
  Logger.dispose();
}
