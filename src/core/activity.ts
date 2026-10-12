/**
 * Decides whether "the agent" is still working.
 *
 * Two independent signals:
 *  - terminal commands that VS Code reports as running (shell integration);
 *  - CPU used by watched processes (claude, codex, aider…), sampled periodically.
 *
 * Either one counts as activity. The session is considered finished once
 * neither has shown activity for `idleMs`.
 */
export class ActivityTracker {
  private readonly running = new Set<unknown>();
  private lastCpuSeconds: number | null = null;
  private lastCpuAt: number | null = null;
  private cpuBusy = false;
  private lastActiveAt: number;
  private commands = 0;
  /** Most recent CPU usage of watched processes, in % of one core. */
  cpuPercent: number | null = null;

  constructor(
    startedAt: number,
    private readonly cpuThresholdPercent: number,
  ) {
    this.lastActiveAt = startedAt;
  }

  /** A terminal command started. `key` identifies it so the end can be matched. */
  commandStarted(key: unknown, now: number): void {
    this.running.add(key);
    this.commands++;
    this.lastActiveAt = now;
  }

  commandEnded(key: unknown, now: number): void {
    if (this.running.delete(key)) {
      this.lastActiveAt = now;
    }
  }

  /**
   * Feeds a cumulative CPU-seconds reading for all watched processes.
   * Readings can go *down* when a process exits; that window is ignored.
   */
  cpuSample(totalCpuSeconds: number | null, now: number): void {
    if (totalCpuSeconds === null) {
      this.cpuBusy = false;
      this.cpuPercent = null;
      return;
    }
    if (this.lastCpuSeconds !== null && this.lastCpuAt !== null && now > this.lastCpuAt) {
      const used = totalCpuSeconds - this.lastCpuSeconds;
      const elapsed = (now - this.lastCpuAt) / 1000;
      const percent = used >= 0 ? (used / elapsed) * 100 : 0;
      this.cpuPercent = Math.round(percent * 10) / 10;
      this.cpuBusy = percent >= this.cpuThresholdPercent;
      if (this.cpuBusy) {
        this.lastActiveAt = now;
      }
    }
    this.lastCpuSeconds = totalCpuSeconds;
    this.lastCpuAt = now;
  }

  get runningCommands(): number {
    return this.running.size;
  }

  get commandsStarted(): number {
    return this.commands;
  }

  /** Is something visibly working right now? */
  isBusy(): boolean {
    return this.running.size > 0 || this.cpuBusy;
  }

  get lastActivityAt(): number {
    return this.lastActiveAt;
  }

  /** True once nothing has happened for `idleMs`. */
  isFinished(now: number, idleMs: number): boolean {
    if (this.isBusy()) {
      return false;
    }
    return now - this.lastActiveAt >= idleMs;
  }
}
