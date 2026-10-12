import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
  applyCommands,
  parseAcDc,
  parseActiveScheme,
  POWER_SETTINGS,
  restoreScript,
  RUNONCE_KEY,
  RUNONCE_VALUE,
  SavedSetting,
} from '../core/powercfg';
import { BackendEvents, EngageOptions, SystemStatus } from '../core/types';
import { isProcessAlive, PlatformBackend, run, runSync } from './backend';

/** What we persist so an interrupted session can always be undone. */
interface SavedState {
  version: 1;
  ownerPid: number;
  createdAt: number;
  scheme: string;
  original: SavedSetting[];
}

const STATE_FILE = 'windows-power-state.json';
const RESTORE_FILE = 'restore-power-settings.cmd';

function systemTool(name: string): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', name);
}

function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export class WindowsBackend implements PlatformBackend {
  readonly id = 'windows' as const;
  private helper: ChildProcess | null = null;
  private state: SavedState | null = null;
  private stopping = false;

  constructor(
    private readonly storageDir: string,
    private readonly helperScript: string,
  ) {}

  private get statePath(): string {
    return path.join(this.storageDir, STATE_FILE);
  }

  private get restorePath(): string {
    return path.join(this.storageDir, RESTORE_FILE);
  }

  async checkSupport(): Promise<string | null> {
    if (!fs.existsSync(powershellPath())) {
      return 'Windows PowerShell was not found.';
    }
    if (!fs.existsSync(this.helperScript)) {
      return 'The helper script is missing from the extension folder.';
    }
    try {
      await run(systemTool('powercfg.exe'), ['/getactivescheme']);
    } catch (error) {
      return `powercfg is not available: ${(error as Error).message}`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Power settings
  // -------------------------------------------------------------------------

  private async powercfg(args: string[]): Promise<string> {
    return (await run(systemTool('powercfg.exe'), args)).stdout;
  }

  private async readCurrent(scheme: string, log: (m: string) => void): Promise<SavedSetting[]> {
    const saved: SavedSetting[] = [];
    for (const s of POWER_SETTINGS) {
      try {
        // /qh, not /q: many laptops hide the lid-close setting, and /q then prints only the scheme header.
        const values = parseAcDc(await this.powercfg(['/qh', scheme, s.subgroup, s.setting]));
        saved.push({ key: s.key, subgroup: s.subgroup, setting: s.setting, ...values });
      } catch (error) {
        if (s.required) throw error;
        log(`Skipping power setting "${s.key}": ${(error as Error).message}`);
      }
    }
    return saved;
  }

  private async apply(scheme: string, values: SavedSetting[]): Promise<void> {
    for (const args of applyCommands(scheme, values)) {
      await this.powercfg(args);
    }
  }

  private applySync(scheme: string, values: SavedSetting[]): void {
    for (const args of applyCommands(scheme, values)) {
      runSync(systemTool('powercfg.exe'), args);
    }
  }

  private writeSafetyNet(state: SavedState): Promise<unknown> {
    fs.mkdirSync(this.storageDir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
    fs.writeFileSync(this.restorePath, restoreScript(state.scheme, state.original), 'utf8');
    // If both VS Code and the helper die (power loss, crash), Windows itself runs
    // the restore script at the next logon. No administrator rights needed.
    return run(systemTool('reg.exe'), [
      'add',
      RUNONCE_KEY,
      '/v',
      RUNONCE_VALUE,
      '/t',
      'REG_SZ',
      '/d',
      `"${systemTool('cmd.exe')}" /d /c "${this.restorePath}"`,
      '/f',
    ]);
  }

  private removeSafetyNet(): void {
    for (const file of [this.statePath, this.restorePath]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* already gone */
      }
    }
    try {
      runSync(systemTool('reg.exe'), ['delete', RUNONCE_KEY, '/v', RUNONCE_VALUE, '/f']);
    } catch {
      /* the value did not exist */
    }
  }

  private readSavedState(): SavedState | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as SavedState;
      return parsed && parsed.version === 1 && Array.isArray(parsed.original) ? parsed : null;
    } catch {
      return null;
    }
  }

  async recover(): Promise<boolean> {
    const saved = this.readSavedState();
    if (!saved) return false;
    if (saved.ownerPid !== process.pid && isProcessAlive(saved.ownerPid)) {
      // Another VS Code window is sleepwalking right now; leave it alone.
      return false;
    }
    await this.apply(saved.scheme, saved.original);
    this.removeSafetyNet();
    return true;
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  async engage(options: EngageOptions, events: BackendEvents): Promise<void> {
    this.stopping = false;
    const scheme = parseActiveScheme(await this.powercfg(['/getactivescheme']));
    const current = await this.readCurrent(scheme, events.onLog);
    const toChange = current.filter((s) => {
      const target = POWER_SETTINGS.find((p) => p.key === s.key)!.target;
      return s.ac !== target || s.dc !== target;
    });

    if (toChange.length > 0) {
      const state: SavedState = {
        version: 1,
        ownerPid: process.pid,
        createdAt: Date.now(),
        scheme,
        original: toChange,
      };
      // Safety net first, changes second: we can always find our way back.
      await this.writeSafetyNet(state);
      this.state = state;
      const targets = toChange.map((s) => {
        const target = POWER_SETTINGS.find((p) => p.key === s.key)!.target;
        return { ...s, ac: target, dc: target };
      });
      try {
        await this.apply(scheme, targets);
      } catch (error) {
        await this.restore().catch(() => undefined);
        throw new Error(
          `Windows refused to change the power settings. If they are managed by your organization, ` +
            `they cannot be changed from here. (${(error as Error).message})`,
        );
      }
      events.onLog(`Power settings changed: ${toChange.map((s) => s.key).join(', ')}`);
    } else {
      events.onLog('Power settings already allow running with the lid closed; nothing to change.');
    }

    try {
      await this.startHelper(options, events);
    } catch (error) {
      await this.restore().catch(() => undefined);
      throw error;
    }
  }

  private startHelper(options: EngageOptions, events: BackendEvents): Promise<void> {
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Sta',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.helperScript,
      '-ParentPid',
      String(process.pid),
      '-Lock',
      options.lockScreen ? '1' : '0',
      '-DisplayOff',
      options.turnOffDisplay ? '1' : '0',
      '-DisplayOffDelayMs',
      String(Math.round(options.displayOffDelayMs)),
      '-ReturnGraceMs',
      String(Math.round(options.returnGraceMs)),
      '-StatusIntervalMs',
      String(Math.round(options.statusIntervalMs)),
    ];
    // Windows PowerShell drops empty arguments passed to -File, which would shift
    // the next parameter into this one, so optional values are only added when set.
    const watch = options.watchProcesses
      .map((p) => p.trim().replace(/\.exe$/i, ''))
      .filter((p) => /^[\w.\- ]+$/.test(p))
      .join(',');
    if (watch) args.push('-WatchProcesses', watch);
    if (this.state) args.push('-RestoreScript', this.restorePath);

    const child = spawn(powershellPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.helper = child;

    return new Promise((resolve, reject) => {
      let ready = false;
      const startupTimeout = setTimeout(() => {
        if (!ready) {
          reject(new Error('The helper did not start within 30 seconds.'));
          child.kill();
        }
      }, 30_000);

      const lines = readline.createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        const message = parseLine(line);
        if (!message) {
          if (line.trim()) events.onLog(`helper: ${line.trim()}`);
          return;
        }
        switch (message.type) {
          case 'ready':
            ready = true;
            clearTimeout(startupTimeout);
            events.onLog(`Helper ready (temperature sensor: ${message.temperature ? 'yes' : 'no'}).`);
            resolve();
            break;
          case 'lid':
            events.onLid(Boolean(message.open), Boolean(message.initial));
            break;
          case 'away':
            events.onAway();
            break;
          case 'input':
            events.onUserInput();
            break;
          case 'status':
            events.onStatus(toStatus(message));
            break;
          case 'display':
            events.onLog(`Display state: ${['off', 'on', 'dimmed'][Number(message.state)] ?? message.state}`);
            break;
          case 'log':
            events.onLog(`helper: ${String(message.message)}`);
            break;
          case 'fatal':
            clearTimeout(startupTimeout);
            if (!ready) reject(new Error(String(message.message)));
            else events.onFatal(String(message.message));
            break;
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) events.onLog(`helper (stderr): ${text}`);
      });

      child.on('error', (error) => {
        clearTimeout(startupTimeout);
        if (!ready) reject(error);
        else events.onFatal(error.message);
      });

      child.on('exit', (code) => {
        clearTimeout(startupTimeout);
        if (this.helper === child) this.helper = null;
        if (!ready) {
          reject(new Error(`The helper exited before it was ready (code ${code}).`));
        } else if (!this.stopping) {
          events.onFatal(`The helper stopped unexpectedly (code ${code}).`);
        }
      });
    });
  }

  private stopHelper(): void {
    const child = this.helper;
    this.helper = null;
    if (child && child.exitCode === null) {
      child.kill();
    }
  }

  private async restore(): Promise<void> {
    if (this.state) {
      await this.apply(this.state.scheme, this.state.original);
      this.state = null;
    }
    this.removeSafetyNet();
  }

  async disengage(): Promise<void> {
    this.stopping = true;
    this.stopHelper();
    await this.restore();
  }

  disengageSync(): void {
    this.stopping = true;
    this.stopHelper();
    if (this.state) {
      try {
        this.applySync(this.state.scheme, this.state.original);
        this.state = null;
        this.removeSafetyNet();
      } catch {
        // Leave the safety net in place: RunOnce or the next start will restore.
      }
    }
  }

  async performEndAction(action: 'sleep' | 'hibernate'): Promise<void> {
    const suspend = () =>
      run(powershellPath(), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)) { exit 1 }",
      ]);
    const hibernate = () => run(systemTool('shutdown.exe'), ['/h']);

    if (action === 'hibernate') {
      await hibernate().catch(suspend);
    } else {
      await suspend().catch(hibernate);
    }
  }
}

interface HelperMessage {
  type: string;
  [key: string]: unknown;
}

function parseLine(line: string): HelperMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as HelperMessage;
    return typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStatus(message: HelperMessage): SystemStatus {
  return {
    batteryPercent: numberOrNull(message.battery),
    onAc: typeof message.ac === 'boolean' ? message.ac : null,
    temperatureC: numberOrNull(message.temp),
    watchedCpuSeconds: numberOrNull(message.cpu),
    watchedProcessCount: numberOrNull(message.procs) ?? 0,
  };
}
