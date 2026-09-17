import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AdbTouch} from '../input/AdbTouch';
import {Device} from './types';

const execFileAsync = promisify(execFile);

export const TEXT_SIZES = [
  'extra-small',
  'small',
  'medium',
  'large',
  'extra-large',
  'extra-extra-large',
  'extra-extra-extra-large',
] as const;

export type TextSize = (typeof TEXT_SIZES)[number];
export type Appearance = 'light' | 'dark';
export type Coordinates = {latitude: number; longitude: number};

export interface DeviceSettingsSnapshot {
  appearance?: Appearance;
  textSize?: TextSize;
  liquidGlassOpacity?: number;
  liquidGlass: boolean;
}

const ANDROID_FONT_SCALES = [0.85, 0.9, 0.95, 1, 1.15, 1.3, 1.5];

export function iosMajorVersion(runtime?: string): number | null {
  const match = runtime?.match(/(?:iOS\s*)?(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function parseCoordinates(value: string): Coordinates | null {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    ? {latitude, longitude}
    : null;
}

function nearestTextSize(scale: number): TextSize {
  let best = 0;
  for (let i = 1; i < ANDROID_FONT_SCALES.length; i++) {
    if (
      Math.abs(ANDROID_FONT_SCALES[i] - scale) <
      Math.abs(ANDROID_FONT_SCALES[best] - scale)
    ) {
      best = i;
    }
  }
  return TEXT_SIZES[best];
}

async function run(file: string, args: string[]): Promise<string> {
  const {stdout} = await execFileAsync(file, args, {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function adbFor(deviceId: string): Promise<{adb: string; serial: string}> {
  const adb = AdbTouch.findAdb();
  if (!adb) throw new Error('adb not found');
  return {adb, serial: await AdbTouch.resolveSerial(adb, deviceId)};
}

async function adbShell(deviceId: string, ...args: string[]): Promise<string> {
  const {adb, serial} = await adbFor(deviceId);
  return run(adb, ['-s', serial, 'shell', ...args]);
}

function findJsonValue(value: unknown, names: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const wanted = new Set(names.map((name) => name.replace(/[^a-z]/gi, '').toLowerCase()));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (wanted.has(key.replace(/[^a-z]/gi, '').toLowerCase())) return child;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findJsonValue(child, names);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function parseDevicectlAppearance(
  json: unknown
): Partial<DeviceSettingsSnapshot> {
  const rawAppearance = String(
    findJsonValue(json, ['mode', 'appearance', 'interfaceStyle', 'userInterfaceStyle']) ?? ''
  ).toLowerCase();
  const rawTextSize = String(
    findJsonValue(json, ['textSize', 'contentSize']) ?? ''
  ).toLowerCase();
  const rawOpacity = Number(findJsonValue(json, ['liquidGlassOpacity']));
  return {
    appearance: rawAppearance.includes('dark')
      ? 'dark'
      : rawAppearance.includes('light')
        ? 'light'
        : undefined,
    textSize: (TEXT_SIZES as readonly string[]).includes(rawTextSize)
      ? (rawTextSize as TextSize)
      : undefined,
    liquidGlassOpacity: Number.isFinite(rawOpacity) ? rawOpacity : undefined,
  };
}

async function readDevicectl(deviceId: string): Promise<Partial<DeviceSettingsSnapshot>> {
  const text = await run('xcrun', [
    'devicectl',
    'device',
    'info',
    'appearance',
    '--device',
    deviceId,
    '--json-output',
    '-',
    '--quiet',
  ]);
  return parseDevicectlAppearance(JSON.parse(text) as unknown);
}

export async function readDeviceSettings(
  device: Device
): Promise<DeviceSettingsSnapshot> {
  const liquidGlass =
    device.platform === 'ios' && (iosMajorVersion(device.runtime) ?? 0) >= 26;
  const snapshot: DeviceSettingsSnapshot = {liquidGlass};

  if (device.platform === 'android') {
    const [night, scale] = await Promise.all([
      adbShell(device.id, 'cmd', 'uimode', 'night'),
      adbShell(device.id, 'settings', 'get', 'system', 'font_scale'),
    ]);
    snapshot.appearance = /\byes\b/i.test(night) ? 'dark' : 'light';
    const fontScale = Number(scale);
    if (Number.isFinite(fontScale)) snapshot.textSize = nearestTextSize(fontScale);
    return snapshot;
  }

  if (device.type === 'simulator') {
    try {
      const [appearance, textSize] = await Promise.all([
        run('xcrun', ['simctl', 'ui', device.id, 'appearance']),
        run('xcrun', ['simctl', 'ui', device.id, 'content_size']),
      ]);
      if (appearance === 'light' || appearance === 'dark') snapshot.appearance = appearance;
      if ((TEXT_SIZES as readonly string[]).includes(textSize)) {
        snapshot.textSize = textSize as TextSize;
      }
    } catch {
      // iOS 26 以降は devicectl が同じ値を読み取れるため、ここでは続行する。
    }
    if (!liquidGlass) return snapshot;
  }

  try {
    const appearance = await readDevicectl(device.id);
    if (appearance.appearance) snapshot.appearance = appearance.appearance;
    if (appearance.textSize) snapshot.textSize = appearance.textSize;
    if (appearance.liquidGlassOpacity !== undefined) {
      snapshot.liquidGlassOpacity = appearance.liquidGlassOpacity;
    }
  } catch {
    // Simulator の基本設定は simctl で取得済み。実機も設定操作自体は試せる。
  }
  return snapshot;
}

async function setIosAppearance(
  device: Device,
  option: string,
  value: string,
  simctlOption?: string
): Promise<void> {
  try {
    await run('xcrun', [
      'devicectl',
      'device',
      'settings',
      'appearance',
      '--device',
      device.id,
      option,
      value,
    ]);
  } catch (error) {
    if (device.type !== 'simulator' || !simctlOption) throw error;
    await run('xcrun', ['simctl', 'ui', device.id, simctlOption, value]);
  }
}

export async function setAppearance(device: Device, value: Appearance): Promise<void> {
  if (device.platform === 'android') {
    await adbShell(device.id, 'cmd', 'uimode', 'night', value === 'dark' ? 'yes' : 'no');
    return;
  }
  await setIosAppearance(device, '--mode', value, 'appearance');
}

export async function setTextSize(device: Device, value: TextSize): Promise<void> {
  const index = TEXT_SIZES.indexOf(value);
  if (device.platform === 'android') {
    await adbShell(
      device.id,
      'settings',
      'put',
      'system',
      'font_scale',
      String(ANDROID_FONT_SCALES[index])
    );
    return;
  }
  await setIosAppearance(device, '--text-size', value, 'content_size');
}

export async function setLiquidGlassOpacity(
  device: Device,
  value: number
): Promise<void> {
  if (
    device.platform !== 'ios' ||
    (iosMajorVersion(device.runtime) ?? 0) < 26 ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error('Liquid Glass requires iOS 26 or later');
  }
  await setIosAppearance(device, '--liquid-glass-opacity', String(value));
}

export async function setLocation(
  device: Device,
  value: Coordinates | null
): Promise<void> {
  if (device.platform === 'ios') {
    const action = value
      ? [
          'coordinate',
          '--device',
          device.id,
          '--latitude',
          String(value.latitude),
          '--longitude',
          String(value.longitude),
        ]
      : ['clear', '--device', device.id];
    try {
      await run('xcrun', ['devicectl', 'device', 'simulate', 'location', ...action]);
    } catch (error) {
      if (device.type !== 'simulator') throw error;
      await run('xcrun', [
        'simctl',
        'location',
        device.id,
        ...(value ? ['set', `${value.latitude},${value.longitude}`] : ['clear']),
      ]);
    }
    return;
  }

  // gps を一時的な test provider に置き換え、clear 時に外して元へ戻す。
  try {
    await adbShell(device.id, 'cmd', 'location', 'providers', 'remove-test-provider', 'gps');
  } catch {
    // 未設定なら remove は失敗する。
  }
  if (!value) return;
  await adbShell(device.id, 'cmd', 'location', 'providers', 'add-test-provider', 'gps');
  await adbShell(
    device.id,
    'cmd',
    'location',
    'providers',
    'set-test-provider-enabled',
    'gps',
    'true'
  );
  await adbShell(
    device.id,
    'cmd',
    'location',
    'providers',
    'set-test-provider-location',
    'gps',
    '--location',
    `${value.latitude},${value.longitude}`
  );
}
