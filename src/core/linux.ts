/**
 * Pure parsers for Linux /proc and /sys files and desktop tools.
 */

/** `/proc/acpi/button/lid/LID0/state` → "state:      open" */
export function parseLidState(content: string): boolean | null {
  if (/\bopen\b/i.test(content)) return true;
  if (/\bclosed\b/i.test(content)) return false;
  return null;
}

export interface ProcStat {
  comm: string;
  /** utime + stime, in clock ticks. */
  ticks: number;
}

/**
 * `/proc/<pid>/stat`. The command name is wrapped in parentheses and may
 * itself contain spaces or parentheses, so we split on the *last* ")".
 */
export function parseProcStat(content: string): ProcStat | null {
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const comm = content.slice(open + 1, close);
  // Fields after the name start at field 3 ("state"), so field N is at index N - 3.
  const rest = content.slice(close + 2).split(' ');
  const utime = Number(rest[14 - 3]);
  const stime = Number(rest[15 - 3]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { comm, ticks: utime + stime };
}

const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'npx', 'uv', 'uvx']);

/**
 * Is this process one of the watched agents?
 *
 * Matches the process name directly ("claude", "codex"), and also agents that
 * run through an interpreter, e.g. `node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js`.
 * `comm` is truncated by the kernel to 15 characters.
 */
export function isWatchedProcess(comm: string, argv: string[], watched: string[]): boolean {
  const name = comm.toLowerCase();
  for (const raw of watched) {
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    if (name === w || (w.length > 15 && name === w.slice(0, 15))) return true;
  }
  const interpreter = name.replace(/[\d.]+$/, '');
  if (!INTERPRETERS.has(name) && !INTERPRETERS.has(interpreter)) return false;
  for (const arg of argv.slice(1, 4)) {
    if (arg.startsWith('-')) continue;
    const segments = arg.toLowerCase().split(/[\\/]/);
    for (const w of watched) {
      const target = w.trim().toLowerCase();
      if (!target) continue;
      if (segments.some((s) => s === target || s.startsWith(`${target}-`) || s === `${target}.js`)) return true;
    }
  }
  return false;
}

/** `xprintidle` prints milliseconds. */
export function parseXprintidle(output: string): number | null {
  const value = Number(output.trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** `gdbus call … GetIdletime` prints "(uint64 12345,)". */
export function parseGnomeIdle(output: string): number | null {
  const match = output.match(/uint64\s+(\d+)/);
  return match ? Number(match[1]) : null;
}

/** `/sys/class/thermal/thermal_zone*\/temp` is in millidegrees. */
export function parseMilliCelsius(content: string): number | null {
  const value = Number(content.trim());
  if (!Number.isFinite(value)) return null;
  const celsius = value / 1000;
  return celsius > 0 && celsius < 150 ? celsius : null;
}

/** Which desktop are we on, for choosing how to turn the display off. */
export type DesktopKind = 'x11' | 'gnome-wayland' | 'kde-wayland' | 'other-wayland' | 'unknown';

export function detectDesktop(env: NodeJS.ProcessEnv): DesktopKind {
  const session = (env.XDG_SESSION_TYPE || '').toLowerCase();
  const desktop = (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').toLowerCase();
  if (session === 'x11' || (!session && env.DISPLAY && !env.WAYLAND_DISPLAY)) return 'x11';
  if (session === 'wayland' || env.WAYLAND_DISPLAY) {
    if (desktop.includes('gnome') || desktop.includes('ubuntu') || desktop.includes('pop')) return 'gnome-wayland';
    if (desktop.includes('kde') || desktop.includes('plasma')) return 'kde-wayland';
    return 'other-wayland';
  }
  return 'unknown';
}
