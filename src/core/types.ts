/**
 * Shared, VS Code–independent types. Everything under `src/core` is pure
 * logic so it can be unit-tested with plain Node.
 */

/** How long a sleepwalking session should last. */
export type Mode = 'untilReturn' | 'whileAgent' | 'timer';

/** Why a session ended. */
export type EndReason =
  | 'manual' // the user pressed "Wake up"
  | 'returned' // lid opened or keyboard/mouse used
  | 'agentFinished' // whileAgent mode: nothing has been running for a while
  | 'timerEnded' // timer mode: the chosen duration elapsed
  | 'timeLimit' // safety net: sleepwalker.maxHours elapsed
  | 'battery' // guardrail: battery too low
  | 'temperature' // guardrail: machine too hot
  | 'error' // the platform helper died or failed
  | 'shutdown'; // VS Code is closing

/** What to do with the machine when a session ends without the user around. */
export type EndAction = 'sleep' | 'hibernate' | 'none';

/** A snapshot of the machine, reported periodically by the platform backend. */
export interface SystemStatus {
  /** 0–100, or null when the machine has no battery / it cannot be read. */
  batteryPercent: number | null;
  /** true on AC power, false on battery, null when unknown. */
  onAc: boolean | null;
  /** Hottest sensor in °C, or null when no sensor is readable. */
  temperatureC: number | null;
  /** Cumulative CPU seconds used by watched agent processes, or null if unavailable. */
  watchedCpuSeconds: number | null;
  /** How many watched agent processes are running. */
  watchedProcessCount: number;
}

/** Things the backend can tell us while a session is running. */
export interface BackendEvents {
  /** Lid state changed. `initial` is true for the first report after engaging. */
  onLid(open: boolean, initial: boolean): void;
  /** The screen was actually locked/turned off (lid closed, or the no-lid fallback delay fired). */
  onAway(): void;
  /** Keyboard/mouse input was detected after the grace period. */
  onUserInput(): void;
  /** Periodic machine snapshot. */
  onStatus(status: SystemStatus): void;
  /** The helper failed or died unexpectedly. */
  onFatal(message: string): void;
  /** Diagnostic line for the output channel. */
  onLog(message: string): void;
}

export interface EngageOptions {
  lockScreen: boolean;
  turnOffDisplay: boolean;
  displayOffDelayMs: number;
  returnGraceMs: number;
  statusIntervalMs: number;
  watchProcesses: string[];
}

/** What a backend can do on this particular machine. */
export interface Capabilities {
  lid: boolean;
  userInput: boolean;
  battery: boolean;
  temperature: boolean;
  displayOff: boolean;
}
