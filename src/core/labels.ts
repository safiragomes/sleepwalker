import { EndReason, Mode } from './types';
import { formatDuration, TimelineEntry } from './session';

/**
 * Signature-compatible with `vscode.l10n.t`, so pure code can be localized
 * without importing `vscode`. Tests pass a simple formatter.
 */
export type Translate = (message: string, ...args: Array<string | number | boolean>) => string;

export function modeLabel(mode: Mode, t: Translate, timerMs?: number | null): string {
  switch (mode) {
    case 'untilReturn':
      return t('Until I come back');
    case 'whileAgent':
      return t('While the agent works');
    case 'timer':
      return timerMs ? t('For {0}', formatDuration(timerMs)) : t('For a set time');
  }
}

/** Short headline describing how a session ended. */
export function endHeadline(reason: EndReason, t: Translate): string {
  switch (reason) {
    case 'manual':
      return t('You woke it up');
    case 'returned':
      return t('Welcome back');
    case 'agentFinished':
      return t('The agent finished');
    case 'timerEnded':
      return t('Time is up');
    case 'timeLimit':
      return t('Safety time limit reached');
    case 'battery':
      return t('Battery is running low');
    case 'temperature':
      return t('The machine got too hot');
    case 'error':
      return t('Sleepwalker stopped unexpectedly');
    case 'shutdown':
      return t('VS Code was closed');
  }
}

export function timelineLabel(entry: TimelineEntry, t: Translate): string {
  switch (entry.kind) {
    case 'started':
      return t('Started sleepwalking');
    case 'lidClosed':
      return t('Lid closed');
    case 'lidOpened':
      return t('Lid opened');
    case 'agentBusy':
      return t('Agent working');
    case 'agentIdle':
      return t('Agent went quiet');
    case 'warningBattery':
      return t('Battery warning ({0}%)', entry.value ?? '?');
    case 'warningTemperature':
      return t('Temperature warning ({0} °C)', entry.value !== undefined ? Math.round(entry.value) : '?');
    case 'ended':
      return entry.reason ? endHeadline(entry.reason, t) : t('Ended');
  }
}

/** What the machine will do next, for unattended ends. */
export function endActionLabel(action: 'sleep' | 'hibernate' | 'none', t: Translate): string {
  switch (action) {
    case 'sleep':
      return t('The computer is going to sleep now.');
    case 'hibernate':
      return t('The computer is going to hibernate now.');
    case 'none':
      return t('The computer stays on with its normal power settings.');
  }
}
