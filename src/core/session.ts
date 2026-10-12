import { EndReason, Mode, SystemStatus } from './types';

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

export interface GuardrailConfig {
  /** Stop below this battery level when not on AC. 0 disables. */
  minBatteryPercent: number;
  /** Stop above this temperature. 0 disables. */
  maxTemperatureC: number;
  /** Hard ceiling for any session, in hours. */
  maxHours: number;
}

export type GuardrailVerdict =
  | { kind: 'ok' }
  | { kind: 'warn'; reason: 'battery' | 'temperature'; value: number }
  | { kind: 'stop'; reason: 'battery' | 'temperature' | 'timeLimit'; value: number };

/** Remembers which warnings were already sent, so each one goes out once. */
export interface GuardrailMemory {
  batteryWarned: boolean;
  temperatureWarned: boolean;
}

export const BATTERY_WARNING_MARGIN = 10;
export const TEMPERATURE_WARNING_MARGIN = 5;

export function evaluateGuardrails(
  status: SystemStatus | null,
  config: GuardrailConfig,
  memory: GuardrailMemory,
  elapsedMs: number,
): GuardrailVerdict {
  if (config.maxHours > 0 && elapsedMs >= config.maxHours * 3_600_000) {
    return { kind: 'stop', reason: 'timeLimit', value: config.maxHours };
  }
  if (!status) {
    return { kind: 'ok' };
  }

  const battery = status.batteryPercent;
  const onBattery = status.onAc !== true;
  if (config.minBatteryPercent > 0 && battery !== null && onBattery) {
    if (battery <= config.minBatteryPercent) {
      return { kind: 'stop', reason: 'battery', value: battery };
    }
    if (!memory.batteryWarned && battery <= config.minBatteryPercent + BATTERY_WARNING_MARGIN) {
      memory.batteryWarned = true;
      return { kind: 'warn', reason: 'battery', value: battery };
    }
  }

  const temperature = status.temperatureC;
  if (config.maxTemperatureC > 0 && temperature !== null) {
    if (temperature >= config.maxTemperatureC) {
      return { kind: 'stop', reason: 'temperature', value: temperature };
    }
    if (!memory.temperatureWarned && temperature >= config.maxTemperatureC - TEMPERATURE_WARNING_MARGIN) {
      memory.temperatureWarned = true;
      return { kind: 'warn', reason: 'temperature', value: temperature };
    }
  }

  return { kind: 'ok' };
}

// ---------------------------------------------------------------------------
// Session record
// ---------------------------------------------------------------------------

export type TimelineKind =
  | 'started'
  | 'lidClosed'
  | 'lidOpened'
  | 'agentBusy'
  | 'agentIdle'
  | 'warningBattery'
  | 'warningTemperature'
  | 'ended';

export interface TimelineEntry {
  at: number;
  kind: TimelineKind;
  /** Optional number shown next to the entry (battery %, °C…). */
  value?: number;
  /** For 'ended': why. */
  reason?: EndReason;
}

/** Everything the UI and the e-mail need to describe a session. Plain JSON. */
export interface SessionSummary {
  mode: Mode;
  timerMs: number | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  endReason: EndReason;
  batteryStart: number | null;
  batteryEnd: number | null;
  batteryMin: number | null;
  temperatureMax: number | null;
  lidClosedMs: number;
  commandsStarted: number;
  lastActivityAt: number | null;
  timeline: TimelineEntry[];
}

const MAX_TIMELINE = 40;

export class SessionRecorder {
  private batteryStart: number | null = null;
  private batteryLast: number | null = null;
  private batteryMin: number | null = null;
  private temperatureMax: number | null = null;
  private lidClosedSince: number | null = null;
  private lidClosedTotal = 0;
  private agentBusy = false;
  readonly timeline: TimelineEntry[] = [];

  constructor(
    readonly mode: Mode,
    readonly startedAt: number,
    readonly timerMs: number | null,
  ) {
    this.add({ at: startedAt, kind: 'started' });
  }

  private add(entry: TimelineEntry): void {
    this.timeline.push(entry);
    if (this.timeline.length > MAX_TIMELINE) {
      // Keep the first entry ("started") and the most recent ones.
      this.timeline.splice(1, 1);
    }
  }

  status(status: SystemStatus): void {
    if (status.batteryPercent !== null) {
      if (this.batteryStart === null) this.batteryStart = status.batteryPercent;
      this.batteryLast = status.batteryPercent;
      this.batteryMin = this.batteryMin === null ? status.batteryPercent : Math.min(this.batteryMin, status.batteryPercent);
    }
    if (status.temperatureC !== null) {
      this.temperatureMax =
        this.temperatureMax === null ? status.temperatureC : Math.max(this.temperatureMax, status.temperatureC);
    }
  }

  lid(open: boolean, now: number): void {
    if (!open && this.lidClosedSince === null) {
      this.lidClosedSince = now;
      this.add({ at: now, kind: 'lidClosed' });
    } else if (open && this.lidClosedSince !== null) {
      this.lidClosedTotal += now - this.lidClosedSince;
      this.lidClosedSince = null;
      this.add({ at: now, kind: 'lidOpened' });
    }
  }

  /** Records transitions of the agent's busy/idle state (not every sample). */
  agent(busy: boolean, now: number): void {
    if (busy !== this.agentBusy) {
      this.agentBusy = busy;
      this.add({ at: now, kind: busy ? 'agentBusy' : 'agentIdle' });
    }
  }

  warning(reason: 'battery' | 'temperature', value: number, now: number): void {
    this.add({ at: now, kind: reason === 'battery' ? 'warningBattery' : 'warningTemperature', value });
  }

  isLidClosed(): boolean {
    return this.lidClosedSince !== null;
  }

  lidClosedMs(now: number): number {
    return this.lidClosedTotal + (this.lidClosedSince !== null ? now - this.lidClosedSince : 0);
  }

  finish(reason: EndReason, now: number, commandsStarted: number, lastActivityAt: number | null): SessionSummary {
    this.add({ at: now, kind: 'ended', reason });
    return {
      mode: this.mode,
      timerMs: this.timerMs,
      startedAt: this.startedAt,
      endedAt: now,
      durationMs: now - this.startedAt,
      endReason: reason,
      batteryStart: this.batteryStart,
      batteryEnd: this.batteryLast,
      batteryMin: this.batteryMin,
      temperatureMax: this.temperatureMax,
      lidClosedMs: this.lidClosedMs(now),
      commandsStarted,
      lastActivityAt,
      timeline: [...this.timeline],
    };
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 3_725_000 → "1h 02m"; 65_000 → "1m 05s"; 9_000 → "9s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** 3_725_000 → "1:02:05" — for the live clock. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Ends that happen while the user is away, after which the machine should go to sleep. */
export function isUnattendedEnd(reason: EndReason): boolean {
  return (
    reason === 'agentFinished' ||
    reason === 'timerEnded' ||
    reason === 'timeLimit' ||
    reason === 'battery' ||
    reason === 'temperature'
  );
}
