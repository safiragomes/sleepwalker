import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActivityTracker } from './core/activity';
import { endActionLabel, endHeadline, modeLabel } from './core/labels';
import {
  evaluateGuardrails,
  formatDuration,
  GuardrailMemory,
  isUnattendedEnd,
  SessionRecorder,
  SessionSummary,
} from './core/session';
import { EndReason, Mode, SystemStatus } from './core/types';
import { EmailEvent, readSettings, Settings } from './config';
import { Mailer, withTimeout } from './email';
import { isProcessAlive, PlatformBackend } from './platform/backend';

const TICK_MS = 5_000;
const STATUS_INTERVAL_MS = 10_000;
const LAST_SUMMARY_KEY = 'sleepwalker.lastSummary';
const LOCK_FILE = 'session.lock.json';

export type Phase = 'idle' | 'starting' | 'active' | 'stopping';

/** Live data shown while a session runs. */
export interface LiveView {
  mode: Mode;
  startedAt: number;
  /** When a timer-mode session ends on its own. */
  endsAt: number | null;
  /** When the safety limit kicks in. */
  limitAt: number;
  status: SystemStatus | null;
  lidOpen: boolean | null;
  lidClosedMs: number;
  agentBusy: boolean;
  runningCommands: number;
  commandsStarted: number;
  cpuPercent: number | null;
  lastActivityAt: number;
  /** whileAgent mode: when the session will end if nothing else happens. */
  finishesAt: number | null;
}

export interface ControllerView {
  platform: 'windows' | 'linux' | 'unsupported';
  phase: Phase;
  live: LiveView | null;
  lastSummary: SessionSummary | null;
  error: string | null;
}

interface Session {
  mode: Mode;
  timerMs: number | null;
  startedAt: number;
  settings: Settings;
  tracker: ActivityTracker;
  recorder: SessionRecorder;
  memory: GuardrailMemory;
  status: SystemStatus | null;
  lidOpen: boolean | null;
  windowBlurred: boolean;
  /** When the screen actually went away (lid closed, or the no-lid fallback fired). Null until then. */
  awaySince: number | null;
  tick: NodeJS.Timeout;
}

export class Controller implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires whenever anything the UI shows has changed. */
  readonly onDidChange = this.changed.event;

  private phase: Phase = 'idle';
  private session: Session | null = null;
  private error: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  /** Terminal commands running right now, tracked even outside sessions. */
  private readonly runningCommands = new Set<vscode.TerminalShellExecution>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: PlatformBackend | null,
    private readonly mailer: Mailer,
    private readonly log: (message: string) => void,
  ) {
    this.disposables.push(
      this.changed,
      vscode.window.onDidStartTerminalShellExecution((e) => {
        this.runningCommands.add(e.execution);
        if (this.session?.settings.agent.watchTerminals) {
          this.session.tracker.commandStarted(e.execution, Date.now());
          this.agentChanged();
        }
      }),
      vscode.window.onDidEndTerminalShellExecution((e) => {
        this.runningCommands.delete(e.execution);
        if (this.session) {
          this.session.tracker.commandEnded(e.execution, Date.now());
          this.agentChanged();
        }
      }),
      vscode.window.onDidChangeWindowState((state) => this.onWindowState(state.focused)),
    );
    void vscode.commands.executeCommand('setContext', 'sleepwalker.active', false);
  }

  // -------------------------------------------------------------------------
  // View
  // -------------------------------------------------------------------------

  get isActive(): boolean {
    return this.phase === 'active';
  }

  get view(): ControllerView {
    const s = this.session;
    let live: LiveView | null = null;
    if (s) {
      const now = Date.now();
      const idleMs = s.settings.agent.idleMinutes * 60_000;
      live = {
        mode: s.mode,
        startedAt: s.startedAt,
        endsAt: s.timerMs ? s.startedAt + s.timerMs : null,
        limitAt: s.startedAt + s.settings.maxHours * 3_600_000,
        status: s.status,
        lidOpen: s.lidOpen,
        lidClosedMs: s.recorder.lidClosedMs(now),
        agentBusy: s.tracker.isBusy(),
        runningCommands: s.tracker.runningCommands,
        commandsStarted: s.tracker.commandsStarted,
        cpuPercent: s.tracker.cpuPercent,
        lastActivityAt: s.tracker.lastActivityAt,
        finishesAt: s.mode === 'whileAgent' && !s.tracker.isBusy() ? s.tracker.lastActivityAt + idleMs : null,
      };
    }
    return {
      platform: this.backend ? this.backend.id : 'unsupported',
      phase: this.phase,
      live,
      lastSummary: this.context.globalState.get<SessionSummary>(LAST_SUMMARY_KEY) ?? null,
      error: this.error,
    };
  }

  private fire(): void {
    this.changed.fire();
  }

  // -------------------------------------------------------------------------
  // Crash recovery & multi-window lock
  // -------------------------------------------------------------------------

  private get lockPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, LOCK_FILE);
  }

  /** Pid of another VS Code window that is sleepwalking right now, if any. */
  private otherOwner(): number | null {
    try {
      const { pid } = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid: number };
      return pid !== process.pid && isProcessAlive(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  private takeLock(): void {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
  }

  private releaseLock(): void {
    try {
      const { pid } = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid: number };
      if (pid === process.pid) fs.rmSync(this.lockPath, { force: true });
    } catch {
      /* no lock */
    }
  }

  /** Called once at startup: undo anything an interrupted session left behind. */
  async recover(): Promise<void> {
    if (!this.backend || this.otherOwner() !== null) return;
    try {
      if (await this.backend.recover()) {
        this.log('Restored power settings left by an interrupted session.');
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Sleepwalker restored your power settings after an interrupted session.'),
        );
      }
    } catch (error) {
      this.log(`Recovery failed: ${(error as Error).message}`);
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Sleepwalker could not restore your power settings after an interrupted session: {0}',
          (error as Error).message,
        ),
      );
    }
    this.releaseLock();
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  async start(mode: Mode, timerMs: number | null = null): Promise<void> {
    if (this.phase !== 'idle') return;
    this.error = null;

    if (!this.backend) {
      this.fail(vscode.l10n.t('Sleepwalker supports Windows and Linux for now.'));
      return;
    }
    if (this.otherOwner() !== null) {
      this.fail(vscode.l10n.t('Sleepwalker is already active in another VS Code window.'));
      return;
    }

    this.phase = 'starting';
    this.fire();

    const unsupported = await this.backend.checkSupport();
    if (unsupported) {
      this.phase = 'idle';
      this.fail(unsupported);
      return;
    }

    const settings = readSettings();
    const startedAt = Date.now();
    const tracker = new ActivityTracker(startedAt, settings.agent.cpuThresholdPercent);
    if (settings.agent.watchTerminals) {
      for (const execution of this.runningCommands) tracker.commandStarted(execution, startedAt);
    }

    this.takeLock();
    try {
      await this.backend.engage(
        {
          lockScreen: settings.lockScreen,
          turnOffDisplay: settings.turnOffDisplay,
          displayOffDelayMs: settings.displayOffDelaySeconds * 1000,
          returnGraceMs: settings.returnGraceSeconds * 1000,
          statusIntervalMs: STATUS_INTERVAL_MS,
          watchProcesses: settings.agent.watchProcesses,
        },
        {
          onLid: (open, initial) => this.onLid(open, initial),
          onAway: () => this.onAway(),
          onUserInput: () => this.onReturn('input'),
          onStatus: (status) => this.onStatus(status),
          onFatal: (message) => void this.onFatal(message),
          onLog: this.log,
        },
      );
    } catch (error) {
      this.releaseLock();
      this.phase = 'idle';
      this.fail(vscode.l10n.t('Could not start sleepwalking: {0}', (error as Error).message));
      return;
    }

    this.session = {
      mode,
      timerMs,
      startedAt,
      settings,
      tracker,
      recorder: new SessionRecorder(mode, startedAt, timerMs),
      memory: { batteryWarned: false, temperatureWarned: false },
      status: null,
      lidOpen: null,
      windowBlurred: false,
      awaySince: null,
      tick: setInterval(() => this.onTick(), TICK_MS),
    };
    this.phase = 'active';
    void vscode.commands.executeCommand('setContext', 'sleepwalker.active', true);
    this.log(`Sleepwalking started (${mode}${timerMs ? `, ${formatDuration(timerMs)}` : ''}).`);
    this.fire();

    void this.mailer.notify('started', { kind: 'started', mode, timerMs, startedAt });
  }

  private fail(message: string): void {
    this.error = message;
    this.log(message);
    void vscode.window.showErrorMessage(message, vscode.l10n.t('Show log')).then((choice) => {
      if (choice) void vscode.commands.executeCommand('sleepwalker.showLog');
    });
    this.fire();
  }

  // -------------------------------------------------------------------------
  // Events while active
  // -------------------------------------------------------------------------

  private graceOver(s: Session): boolean {
    // Nothing has happened yet (lid still open, screen still on): normal typing and
    // window switching while the agent runs is not "the user is back".
    if (s.awaySince === null) return false;
    const grace = Math.max(s.settings.returnGraceSeconds, s.settings.displayOffDelaySeconds + 2) * 1000;
    return Date.now() - s.awaySince >= grace;
  }

  private onAway(): void {
    const s = this.session;
    if (!s || s.awaySince !== null) return;
    s.awaySince = Date.now();
    this.log('Screen locked/turned off.');
    this.fire();
  }

  private onLid(open: boolean, initial: boolean): void {
    const s = this.session;
    if (!s) return;
    const wasClosed = s.lidOpen === false;
    s.lidOpen = open;
    s.recorder.lid(open, Date.now());
    this.log(`Lid ${open ? 'opened' : 'closed'}${initial ? ' (initial state)' : ''}.`);
    this.fire();
    if (open && !initial && wasClosed) {
      this.onReturn('lid');
    }
  }

  private onWindowState(focused: boolean): void {
    const s = this.session;
    if (!s || this.phase !== 'active') return;
    // Locking the screen or turning the display off takes focus away; getting it
    // back afterwards means someone is at the keyboard again.
    if (!focused) {
      s.windowBlurred = true;
    } else if (s.windowBlurred && (s.settings.lockScreen || s.settings.turnOffDisplay) && this.graceOver(s)) {
      this.onReturn('focus');
    }
  }

  private onReturn(source: 'lid' | 'input' | 'focus'): void {
    const s = this.session;
    if (!s || this.phase !== 'active') return;
    if (source !== 'lid' && !this.graceOver(s)) return;
    this.log(`User is back (${source}).`);
    void this.stop('returned');
  }

  private onStatus(status: SystemStatus): void {
    const s = this.session;
    if (!s) return;
    const now = Date.now();
    s.status = status;
    s.recorder.status(status);
    s.tracker.cpuSample(status.watchedCpuSeconds, now);
    this.agentChanged();
    this.checkGuardrails();
  }

  private agentChanged(): void {
    const s = this.session;
    if (!s) return;
    s.recorder.agent(s.tracker.isBusy(), Date.now());
    this.fire();
  }

  private async onFatal(message: string): Promise<void> {
    this.log(`Fatal: ${message}`);
    this.error = message;
    await this.stop('error');
  }

  private onTick(): void {
    const s = this.session;
    if (!s || this.phase !== 'active') return;
    const now = Date.now();

    if (s.mode === 'timer' && s.timerMs && now - s.startedAt >= s.timerMs) {
      void this.stop('timerEnded');
      return;
    }
    if (s.mode === 'whileAgent' && s.tracker.isFinished(now, s.settings.agent.idleMinutes * 60_000)) {
      void this.stop('agentFinished');
      return;
    }
    this.checkGuardrails();
    this.fire();
  }

  private checkGuardrails(): void {
    const s = this.session;
    if (!s || this.phase !== 'active') return;
    const verdict = evaluateGuardrails(
      s.status,
      {
        minBatteryPercent: s.settings.guardrails.minBatteryPercent,
        maxTemperatureC: s.settings.guardrails.maxTemperatureC,
        maxHours: s.settings.maxHours,
      },
      s.memory,
      Date.now() - s.startedAt,
    );
    if (verdict.kind === 'stop') {
      void this.stop(verdict.reason);
    } else if (verdict.kind === 'warn') {
      s.recorder.warning(verdict.reason, verdict.value, Date.now());
      this.log(`Warning: ${verdict.reason} at ${verdict.value}.`);
      void this.mailer.notify('warning', {
        kind: 'warning',
        reason: verdict.reason,
        value: verdict.value,
        elapsedMs: Date.now() - s.startedAt,
      });
      this.fire();
    }
  }

  // -------------------------------------------------------------------------
  // Stop
  // -------------------------------------------------------------------------

  async stop(reason: EndReason): Promise<void> {
    const s = this.session;
    if (!s || this.phase !== 'active' || !this.backend) return;
    this.phase = 'stopping';
    clearInterval(s.tick);
    this.fire();

    const now = Date.now();
    const lidClosed = s.recorder.isLidClosed();
    const summary = s.recorder.finish(reason, now, s.tracker.commandsStarted, s.tracker.lastActivityAt);
    const endAction = s.settings.endAction;
    const actOnMachine = endAction !== 'none' && (isUnattendedEnd(reason) || (reason === 'error' && lidClosed));
    this.log(`Sleepwalking ended: ${reason} after ${formatDuration(summary.durationMs)}.`);

    // E-mail first: once the machine sleeps there is no network.
    const event = emailEventFor(reason);
    if (event) {
      await withTimeout(
        this.mailer.notify(event, { kind: 'ended', summary, endAction, willActOnMachine: actOnMachine }),
        25_000,
      );
    }

    try {
      await this.backend.disengage();
    } catch (error) {
      this.log(`Restoring power settings failed: ${(error as Error).message}`);
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Sleepwalker could not restore your power settings: {0}. It will try again the next time VS Code starts.',
          (error as Error).message,
        ),
      );
    }

    this.releaseLock();
    await this.context.globalState.update(LAST_SUMMARY_KEY, summary);
    this.session = null;
    this.phase = 'idle';
    if (reason !== 'error') this.error = null;
    void vscode.commands.executeCommand('setContext', 'sleepwalker.active', false);
    this.fire();

    this.announce(summary, endAction, actOnMachine);

    if (actOnMachine) {
      // A short pause lets the notification and logs settle before sleeping.
      setTimeout(() => {
        this.backend!.performEndAction(endAction).catch((error: Error) =>
          this.log(`Could not ${endAction}: ${error.message}`),
        );
      }, 3_000);
    }
  }

  private announce(summary: SessionSummary, endAction: Settings['endAction'], actOnMachine: boolean): void {
    if (summary.endReason === 'shutdown') return;
    const t = vscode.l10n.t;
    const parts = [
      endHeadline(summary.endReason, t) + '.',
      t('Sleepwalked for {0}.', formatDuration(summary.durationMs)),
    ];
    if (summary.commandsStarted > 0) parts.push(t('{0} commands ran.', summary.commandsStarted));
    if (actOnMachine) parts.push(endActionLabel(endAction, t));
    const message = parts.join(' ');
    const show = summary.endReason === 'error' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(message, t('See summary')).then((choice) => {
      if (choice) void vscode.commands.executeCommand('sleepwalker.panel.focus');
    });
  }

  /** VS Code is closing: undo everything synchronously, no e-mail. */
  shutdown(): void {
    const s = this.session;
    if (!s || !this.backend) return;
    clearInterval(s.tick);
    this.backend.disengageSync();
    this.releaseLock();
    this.session = null;
    this.phase = 'idle';
  }

  describeMode(mode: Mode, timerMs?: number | null): string {
    return modeLabel(mode, vscode.l10n.t, timerMs);
  }

  dispose(): void {
    this.shutdown();
    this.disposables.forEach((d) => d.dispose());
  }
}

function emailEventFor(reason: EndReason): EmailEvent | null {
  switch (reason) {
    case 'agentFinished':
      return 'agentFinished';
    case 'timerEnded':
    case 'timeLimit':
      return 'timerEnded';
    case 'battery':
    case 'temperature':
    case 'error':
      return 'guardrail';
    case 'returned':
    case 'manual':
      return 'returned';
    case 'shutdown':
      return null;
  }
}
