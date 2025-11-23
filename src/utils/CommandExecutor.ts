import { execFile, ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import { Logger } from './Logger';

const execFileAsync = promisify(execFile);

export class CommandExecutor {
  private static readonly ALLOWED_COMMANDS = new Set([
    'xcrun',
    'adb',
    'emulator'
  ]);

  private static readonly TIMEOUT_MS = 30000;

  static async execute(
    command: string,
    args: string[],
    options?: ExecFileOptions
  ): Promise<{ stdout: string; stderr: string }> {
    const baseCommand = command.split('/').pop()!;

    if (!CommandExecutor.ALLOWED_COMMANDS.has(baseCommand)) {
      throw new Error(`Command not allowed: ${command}`);
    }

    const sanitizedArgs = args.map(arg => CommandExecutor.sanitizeArg(arg));

    const execOptions: ExecFileOptions = {
      timeout: CommandExecutor.TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      ...options
    };

    Logger.debug(`Executing: ${command} ${sanitizedArgs.join(' ')}`);

    try {
      const result = await execFileAsync(command, sanitizedArgs, execOptions);
      return {
        stdout: result.stdout?.toString() || '',
        stderr: result.stderr?.toString() || ''
      };
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string };
      Logger.error(`Command failed: ${command}`, err);
      throw err;
    }
  }

  static async executeWithBinary(
    command: string,
    args: string[],
    options?: ExecFileOptions
  ): Promise<Buffer> {
    const baseCommand = command.split('/').pop()!;

    if (!CommandExecutor.ALLOWED_COMMANDS.has(baseCommand)) {
      throw new Error(`Command not allowed: ${command}`);
    }

    const sanitizedArgs = args.map(arg => CommandExecutor.sanitizeArg(arg));

    const execOptions: ExecFileOptions = {
      timeout: CommandExecutor.TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'buffer' as BufferEncoding,
      ...options
    };

    Logger.debug(`Executing (binary): ${command} ${sanitizedArgs.join(' ')}`);

    try {
      const result = await execFileAsync(command, sanitizedArgs, execOptions);
      return result.stdout as unknown as Buffer;
    } catch (error) {
      Logger.error(`Command failed: ${command}`, error as Error);
      throw error;
    }
  }

  private static sanitizeArg(arg: string): string {
    return arg.replace(/[;&|`$(){}]/g, '');
  }
}
