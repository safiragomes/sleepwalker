/**
 * Helpers for the Windows `powercfg` tool. Parsing works on any Windows display
 * language because it only relies on GUIDs and hexadecimal values, never on words.
 */

export interface PowerSetting {
  /** Short name used in logs and the state file. */
  key: 'lid' | 'sleepIdle' | 'hibernateIdle';
  subgroup: string;
  setting: string;
  /** Value applied while sleepwalking (0 = "do nothing" / "never"). */
  target: number;
  /** Without this one the whole feature makes no sense, so failures abort. */
  required: boolean;
}

const SUB_BUTTONS = '4f971e89-eebd-4455-a8de-9e59040e7347';
const SUB_SLEEP = '238c9fa8-0aad-41ed-83f4-97be242c8f20';

/**
 * - Lid close action → "Do nothing", the whole point of the extension.
 * - Sleep/hibernate after idle → "Never". On Modern Standby laptops running on
 *   battery, Windows drops keep-awake requests a few minutes after the idle
 *   sleep timeout, so the timeout itself has to be lifted for long sessions.
 */
export const POWER_SETTINGS: PowerSetting[] = [
  { key: 'lid', subgroup: SUB_BUTTONS, setting: '5ca83367-6e45-459f-a27b-476b1d01c936', target: 0, required: true },
  { key: 'sleepIdle', subgroup: SUB_SLEEP, setting: '29f6c1db-86da-48c5-9fdb-f2b67b1f44da', target: 0, required: false },
  { key: 'hibernateIdle', subgroup: SUB_SLEEP, setting: '9d7815a6-7ee4-497e-8888-515a05f02364', target: 0, required: false },
];

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Extracts the scheme GUID from `powercfg /getactivescheme`. */
export function parseActiveScheme(output: string): string {
  const match = output.match(GUID_RE);
  if (!match) {
    throw new Error(`Could not find the active power scheme in: ${output.trim().slice(0, 200)}`);
  }
  return match[0].toLowerCase();
}

export interface AcDc {
  ac: number;
  dc: number;
}

/**
 * Extracts the current AC and DC values from `powercfg /q <scheme> <sub> <setting>`.
 *
 * Enumerated "possible values" are written as `000`, `001`…, and ranges as
 * `0x00000000`/`0xffffffff` *before* the current values. The current AC and DC
 * values are always the last two hexadecimal numbers, in that order.
 */
export function parseAcDc(output: string): AcDc {
  const hex = [...output.matchAll(/0x([0-9a-f]{8})/gi)].map((m) => parseInt(m[1], 16));
  if (hex.length < 2) {
    throw new Error(`Could not read the power setting from: ${output.trim().slice(0, 200)}`);
  }
  const [ac, dc] = hex.slice(-2);
  return { ac, dc };
}

/** A saved setting, ready to be restored later. */
export interface SavedSetting extends AcDc {
  key: PowerSetting['key'];
  subgroup: string;
  setting: string;
}

/** `powercfg` argument lists that write the given values and re-apply the scheme. */
export function applyCommands(scheme: string, values: SavedSetting[]): string[][] {
  const commands: string[][] = [];
  for (const v of values) {
    commands.push(['/setacvalueindex', scheme, v.subgroup, v.setting, String(v.ac)]);
    commands.push(['/setdcvalueindex', scheme, v.subgroup, v.setting, String(v.dc)]);
  }
  commands.push(['/setactive', scheme]);
  return commands;
}

export const RUNONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
export const RUNONCE_VALUE = 'SleepwalkerRestore';

/**
 * A self-contained batch file that puts the original values back. It can run
 * from three places: the helper when VS Code dies, our own crash recovery, and
 * Windows itself at the next logon (through RunOnce) if everything else failed.
 * It deletes itself and its RunOnce entry when done.
 */
export function restoreScript(scheme: string, original: SavedSetting[]): string {
  const lines = [
    '@echo off',
    'rem Written by the Sleepwalker VS Code extension.',
    'rem Puts back the power settings that were changed while sleepwalking.',
    ...applyCommands(scheme, original).map((args) => `powercfg ${args.join(' ')}`),
    `reg delete "${RUNONCE_KEY}" /v ${RUNONCE_VALUE} /f >nul 2>&1`,
    '(goto) 2>nul & del "%~f0"',
  ];
  return lines.join('\r\n') + '\r\n';
}
