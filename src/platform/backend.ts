import { execFile, execFileSync } from 'child_process';
import { BackendEvents, EndAction, EngageOptions } from '../core/types';

/**
 * Everything that is operating-system specific lives behind this interface.
 * A backend is engaged at most once at a time.
 */
export interface PlatformBackend {
  readonly id: 'windows' | 'linux';
  /** Returns a human-readable reason when this machine cannot be supported. */
  checkSupport(): Promise<string | null>;
  /**
   * Undoes changes left behind by a session that never ended cleanly
   * (VS Code crashed, the machine lost power…). Returns true if it did anything.
   */
  recover(): Promise<boolean>;
  engage(options: EngageOptions, events: BackendEvents): Promise<void>;
  disengage(): Promise<void>;
  /** Best-effort synchronous variant used while VS Code is shutting down. */
  disengageSync(): void;
  /** Puts the machine to sleep or hibernation. Called after disengage(). */
  performEndAction(action: Exclude<EndAction, 'none'>): Promise<void>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Promise wrapper around execFile with sane defaults. */
export function run(file: string, args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || '').toString().trim();
          reject(new Error(detail ? `${error.message}: ${detail}` : error.message));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

export function runSync(file: string, args: string[], timeoutMs = 10_000): string {
  return execFileSync(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' });
}

/** Does a process with this pid still exist? */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
