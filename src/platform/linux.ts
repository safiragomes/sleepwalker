import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  detectDesktop,
  DesktopKind,
  isWatchedProcess,
  parseGnomeIdle,
  parseLidState,
  parseMilliCelsius,
  parseProcStat,
  parseXprintidle,
} from '../core/linux';
import { BackendEvents, EngageOptions, SystemStatus } from '../core/types';
import { PlatformBackend, run } from './backend';

type IdleProbe = () => Promise<number | null>;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

async function commandExists(name: string): Promise<boolean> {
  try {
    await run('sh', ['-c', `command -v ${name}`], 5_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux backend built on systemd-logind.
 *
 * Nothing is changed permanently: the lid switch is blocked by an inhibitor
 * lock that lives exactly as long as a small watcher process, which itself
 * exits as soon as VS Code does. There is nothing to restore after a crash.
 */
export class LinuxBackend implements PlatformBackend {
  readonly id = 'linux' as const;
  private inhibitor: ChildProcess | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private displayTurnedOff: DesktopKind | null = null;
  private clockTicks = 100;

  async checkSupport(): Promise<string | null> {
    if (!(await commandExists('systemd-inhibit'))) {
      return 'systemd-inhibit was not found. Sleepwalker needs a systemd-based distribution.';
    }
    return null;
  }

  async recover(): Promise<boolean> {
    return false;
  }

  async engage(options: EngageOptions, events: BackendEvents): Promise<void> {
    this.stopping = false;
    this.displayTurnedOff = null;
    try {
      this.clockTicks = Number((await run('getconf', ['CLK_TCK'])).stdout.trim()) || 100;
    } catch {
      this.clockTicks = 100;
    }

    await this.startInhibitor(events);

    const desktop = detectDesktop(process.env);
    events.onLog(`Desktop detected: ${desktop}`);

    // Lock, then turn the display off. Triggered by the lid actually closing
    // (including if it is already closed when the session starts), so the
    // screen stays on until the person walks away. Only machines with no lid
    // sensor fall back to the old fixed delay, since there is nothing else to wait for.
    let awayTriggered = false;
    let awayAt: number | null = null;
    const triggerAway = async () => {
      if (awayTriggered) return;
      awayTriggered = true;
      awayAt = Date.now();
      events.onAway();
      if (options.lockScreen) await this.lock(events);
      if (options.turnOffDisplay) {
        this.later(options.lockScreen ? 800 : 0, () => this.displayOff(desktop, events));
      }
    };

    // Lid: poll the ACPI state file.
    const lidFile = this.findLidFile();
    if (lidFile) {
      let last: boolean | null = null;
      const pollLid = () => {
        const open = parseLidState(readText(lidFile) ?? '');
        if (open !== null && open !== last) {
          const initial = last === null;
          events.onLid(open, initial);
          last = open;
          if (!open) void triggerAway();
        }
      };
      pollLid();
      this.every(1_000, pollLid);
    } else {
      events.onLog('No lid sensor found under /proc/acpi/button/lid; locking after a short delay instead.');
      this.later(options.displayOffDelayMs, triggerAway);
    }

    // User input: only once the screen has actually gone away (lid closed, or the
    // no-lid fallback fired), compare idle time with the time since the grace period ended.
    // Typing or switching windows before that point is normal use, not a "return".
    const idle = await this.findIdleProbe(desktop);
    if (idle) {
      let reported = false;
      this.every(2_000, async () => {
        if (reported || !awayTriggered || awayAt === null) return;
        const graceEndsAt = awayAt + options.returnGraceMs;
        if (Date.now() < graceEndsAt) return;
        const idleMs = await idle();
        if (idleMs === null) return;
        const sinceGrace = Date.now() - graceEndsAt;
        if (idleMs + 1_500 < sinceGrace) {
          reported = true;
          events.onUserInput();
        }
      });
    } else {
      events.onLog('No idle-time source found (install xprintidle on X11); return is detected by the lid and window focus.');
    }

    // Periodic status.
    const sendStatus = () => events.onStatus(this.readStatus(options.watchProcesses));
    sendStatus();
    this.every(options.statusIntervalMs, sendStatus);
  }

  private startInhibitor(events: BackendEvents): Promise<void> {
    // The watcher exits when VS Code's extension host does, which releases the lock.
    const watcher = `while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done`;
    const child = spawn(
      'systemd-inhibit',
      [
        '--what=handle-lid-switch:sleep',
        '--who=Sleepwalker',
        '--why=Keeping AI agents running with the lid closed',
        '--mode=block',
        'sh',
        '-c',
        watcher,
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.inhibitor = child;

    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    return new Promise((resolve, reject) => {
      const settle = setTimeout(() => {
        child.removeListener('exit', onEarlyExit);
        child.on('exit', (code) => {
          if (this.inhibitor === child) this.inhibitor = null;
          if (!this.stopping) events.onFatal(`The inhibitor lock was released unexpectedly (code ${code}). ${stderr.trim()}`);
        });
        events.onLog('Lid switch and sleep are now inhibited by systemd-logind.');
        resolve();
      }, 1_000);
      const onEarlyExit = (code: number | null) => {
        clearTimeout(settle);
        this.inhibitor = null;
        reject(new Error(`systemd-inhibit refused the lock (code ${code}). ${stderr.trim()}`));
      };
      child.once('exit', onEarlyExit);
      child.once('error', (error) => {
        clearTimeout(settle);
        reject(error);
      });
    });
  }

  private async lock(events: BackendEvents): Promise<void> {
    try {
      await run('loginctl', ['lock-session']);
      return;
    } catch (error) {
      events.onLog(`loginctl lock-session failed: ${(error as Error).message}`);
    }
    try {
      await run('xdg-screensaver', ['lock']);
    } catch (error) {
      events.onLog(`Could not lock the screen: ${(error as Error).message}`);
    }
  }

  private async displayOff(desktop: DesktopKind, events: BackendEvents): Promise<void> {
    try {
      switch (desktop) {
        case 'x11':
          await run('xset', ['dpms', 'force', 'off']);
          break;
        case 'gnome-wayland':
          await run('busctl', [
            '--user',
            'set-property',
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig',
            'PowerSaveMode',
            'i',
            '1',
          ]);
          break;
        case 'kde-wayland':
          await run('kscreen-doctor', ['--dpms', 'off']);
          break;
        default:
          events.onLog('Turning the display off is not supported on this desktop; it will turn off on its own idle timer.');
          return;
      }
      this.displayTurnedOff = desktop;
    } catch (error) {
      events.onLog(`Could not turn the display off: ${(error as Error).message}`);
    }
  }

  private async displayOn(): Promise<void> {
    const desktop = this.displayTurnedOff;
    this.displayTurnedOff = null;
    try {
      if (desktop === 'x11') await run('xset', ['dpms', 'force', 'on']);
      if (desktop === 'gnome-wayland')
        await run('busctl', [
          '--user',
          'set-property',
          'org.gnome.Mutter.DisplayConfig',
          '/org/gnome/Mutter/DisplayConfig',
          'org.gnome.Mutter.DisplayConfig',
          'PowerSaveMode',
          'i',
          '0',
        ]);
      if (desktop === 'kde-wayland') await run('kscreen-doctor', ['--dpms', 'on']);
    } catch {
      /* the display is already on, most likely */
    }
  }

  private findLidFile(): string | null {
    const base = '/proc/acpi/button/lid';
    for (const entry of listDir(base)) {
      const file = path.join(base, entry, 'state');
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  private async findIdleProbe(desktop: DesktopKind): Promise<IdleProbe | null> {
    if (desktop === 'x11' && (await commandExists('xprintidle'))) {
      return async () => parseXprintidle((await run('xprintidle', [], 3_000)).stdout);
    }
    if (desktop === 'gnome-wayland' && (await commandExists('gdbus'))) {
      const probe: IdleProbe = async () =>
        parseGnomeIdle(
          (
            await run(
              'gdbus',
              [
                'call',
                '--session',
                '--dest',
                'org.gnome.Mutter.IdleMonitor',
                '--object-path',
                '/org/gnome/Mutter/IdleMonitor/Core',
                '--method',
                'org.gnome.Mutter.IdleMonitor.GetIdletime',
              ],
              3_000,
            )
          ).stdout,
        );
      try {
        if ((await probe()) !== null) return probe;
      } catch {
        return null;
      }
    }
    return null;
  }

  private readStatus(watched: string[]): SystemStatus {
    let batteryPercent: number | null = null;
    let onAc: boolean | null = null;
    const supplies = '/sys/class/power_supply';
    for (const entry of listDir(supplies)) {
      const dir = path.join(supplies, entry);
      const type = readText(path.join(dir, 'type'))?.trim();
      if (type === 'Battery') {
        const capacity = Number(readText(path.join(dir, 'capacity'))?.trim());
        if (Number.isFinite(capacity)) {
          batteryPercent = batteryPercent === null ? capacity : Math.min(batteryPercent, capacity);
        }
      } else if (type === 'Mains' || type === 'USB') {
        const online = readText(path.join(dir, 'online'))?.trim();
        if (online === '1') onAc = true;
        else if (online === '0' && onAc === null) onAc = false;
      }
    }

    let temperatureC: number | null = null;
    const thermal = '/sys/class/thermal';
    for (const entry of listDir(thermal)) {
      if (!entry.startsWith('thermal_zone')) continue;
      const celsius = parseMilliCelsius(readText(path.join(thermal, entry, 'temp')) ?? '');
      if (celsius !== null) temperatureC = temperatureC === null ? celsius : Math.max(temperatureC, celsius);
    }

    let watchedCpuSeconds: number | null = null;
    let watchedProcessCount = 0;
    if (watched.length > 0) {
      let ticks = 0;
      for (const entry of listDir('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const stat = parseProcStat(readText(`/proc/${entry}/stat`) ?? '');
        if (!stat) continue;
        const argv = (readText(`/proc/${entry}/cmdline`) ?? '').split('\0').filter(Boolean);
        if (isWatchedProcess(stat.comm, argv, watched)) {
          ticks += stat.ticks;
          watchedProcessCount++;
        }
      }
      watchedCpuSeconds = ticks / this.clockTicks;
    }

    return {
      batteryPercent,
      onAc,
      temperatureC: temperatureC === null ? null : Math.round(temperatureC * 10) / 10,
      watchedCpuSeconds,
      watchedProcessCount,
    };
  }

  private later(ms: number, fn: () => unknown): void {
    this.timers.push(
      setTimeout(() => {
        if (!this.stopping) void Promise.resolve(fn()).catch(() => undefined);
      }, ms),
    );
  }

  private every(ms: number, fn: () => unknown): void {
    let busy = false;
    this.timers.push(
      setInterval(() => {
        if (this.stopping || busy) return;
        busy = true;
        void Promise.resolve(fn())
          .catch(() => undefined)
          .finally(() => (busy = false));
      }, ms),
    );
  }

  private releaseInhibitor(): void {
    const child = this.inhibitor;
    this.inhibitor = null;
    if (child?.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM'); // the whole group: inhibitor + watcher
      } catch {
        child.kill('SIGTERM');
      }
    }
  }

  async disengage(): Promise<void> {
    this.disengageSync();
    await this.displayOn();
  }

  disengageSync(): void {
    this.stopping = true;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    this.releaseInhibitor();
  }

  async performEndAction(action: 'sleep' | 'hibernate'): Promise<void> {
    if (action === 'hibernate') {
      await run('systemctl', ['hibernate']).catch(() => run('systemctl', ['suspend']));
    } else {
      await run('systemctl', ['suspend']);
    }
  }
}
