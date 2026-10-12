import * as vscode from 'vscode';
import { EndReason, Mode } from './core/types';
import { TimelineKind } from './core/session';

/**
 * Every piece of text the panel shows, translated on the extension side.
 * Keys are what `media/webview/main.js` uses; values come from `vscode.l10n`.
 */
export function panelStrings(): Record<string, string> {
  const t = vscode.l10n.t;
  const modes: Record<Mode, { title: string; hint: string }> = {
    untilReturn: {
      title: t('Until I come back'),
      hint: t('Ends when you open the lid or touch the keyboard.'),
    },
    whileAgent: {
      title: t('While the agent works'),
      hint: t('Ends a few minutes after the agent goes quiet.'),
    },
    timer: {
      title: t('For a set time'),
      hint: t('Ends after the time you choose.'),
    },
  };
  const reasons: Record<EndReason, string> = {
    manual: t('You woke it up'),
    returned: t('Welcome back'),
    agentFinished: t('The agent finished'),
    timerEnded: t('Time is up'),
    timeLimit: t('Safety time limit reached'),
    battery: t('Battery is running low'),
    temperature: t('The machine got too hot'),
    error: t('Sleepwalker stopped unexpectedly'),
    shutdown: t('VS Code was closed'),
  };
  const timeline: Record<TimelineKind, string> = {
    started: t('Started sleepwalking'),
    lidClosed: t('Lid closed'),
    lidOpened: t('Lid opened'),
    agentBusy: t('Agent working'),
    agentIdle: t('Agent went quiet'),
    warningBattery: t('Battery warning ({0}%)', '{0}'),
    warningTemperature: t('Temperature warning ({0} °C)', '{0}'),
    ended: t('Ended'),
  };

  return {
    'idle.title': t('Close the lid. Your agents keep going.'),
    'idle.lead': t('The screen turns off and the computer stays awake until you come back.'),
    'mode.heading': t('How long'),
    ...prefix('mode.title.', mapValues(modes, (m) => m.title)),
    ...prefix('mode.hint.', mapValues(modes, (m) => m.hint)),
    'timer.minutes': t('{0} min', '{0}'),
    'timer.hours': t('{0} h', '{0}'),
    'start.button': t('Start sleepwalking'),
    'start.starting': t('Getting ready…'),
    'unsupported': t('Sleepwalker supports Windows and Linux for now.'),

    'options.heading': t('While sleepwalking'),
    'options.lockScreen': t('Lock the screen'),
    'options.turnOffDisplay': t('Turn the display off'),
    'options.endAction': t('When it ends on its own'),
    'endAction.sleep': t('Put the computer to sleep'),
    'endAction.hibernate': t('Hibernate'),
    'endAction.none': t('Leave it on'),
    'options.more': t('More settings'),

    'active.title': t('Sleepwalking'),
    'active.endsAt': t('Ends at {0}', '{0}'),
    'active.untilReturn': t('Until you open the lid'),
    'active.whileAgentBusy': t('Ends {0} min after the agent goes quiet', '{0}'),
    'active.whileAgentIdle': t('Ends at {0} unless the agent wakes up', '{0}'),
    'active.agent': t('Agent'),
    'active.agentBusy': t('Working'),
    'active.agentQuiet': t('Quiet for {0}', '{0}'),
    'active.commands': t('{0} running', '{0}'),
    'active.cpu': t('{0}% CPU', '{0}'),
    'active.lid': t('Lid'),
    'active.lidOpen': t('Open'),
    'active.lidClosed': t('Closed for {0}', '{0}'),
    'active.lidUnknown': t('No sensor'),
    'active.battery': t('Battery'),
    'active.charging': t('plugged in'),
    'active.onBattery': t('on battery'),
    'active.noBattery': t('No battery'),
    'active.temperature': t('Temperature'),
    'active.noSensor': t('No sensor'),
    'active.limit': t('Safety stop at {0}', '{0}'),
    'stop.button': t('Wake up'),
    'stop.stopping': t('Waking up…'),

    'summary.heading': t('Last session'),
    'summary.empty': t('Your first session will show up here.'),
    'summary.duration': t('Duration'),
    'summary.lidClosed': t('Lid closed'),
    'summary.battery': t('Battery'),
    'summary.temperature': t('Peak temperature'),
    'summary.commands': t('Commands run'),
    'summary.timeline': t('Timeline'),
    ...prefix('reason.', reasons),
    ...prefix('timeline.', timeline),

    'email.heading': t('Notifications'),
    'email.off': t('Off. Get an e-mail when the agent finishes or something needs you.'),
    'email.on': t('Sending to {0}', '{0}'),
    'email.incomplete': t('Not set up yet'),
    'email.setUp': t('Set up'),
    'email.edit': t('Edit'),
    'email.enable': t('Send me e-mails'),
    'email.provider': t('Provider'),
    'email.provider.gmail': 'Gmail',
    'email.provider.icloud': 'iCloud',
    'email.provider.other': t('Other'),
    'email.host': t('SMTP server'),
    'email.port': t('Port'),
    'email.secure': t('Use SSL/TLS from the start (port 465)'),
    'email.user': t('Sending account (optional)'),
    'email.userHint': t('Defaults to the e-mail above if left blank.'),
    'email.unknownProvider': t('We don\'t recognize this provider. Fill in the server below.'),
    'email.password': t('Password'),
    'email.passwordSaved': t('Saved. Type to replace it.'),
    'email.passwordHint': t('Gmail and iCloud need an app password, not your normal one.'),
    'email.advanced': t('Advanced'),
    'email.to': t('Your e-mail'),
    'email.from': t('From (optional)'),
    'email.events': t('E-mail me when'),
    'email.event.started': t('A session starts'),
    'email.event.agentFinished': t('The agent finishes'),
    'email.event.timerEnded': t('The time is up'),
    'email.event.guardrail': t('Sleepwalker stops for safety'),
    'email.event.warning': t('Battery or temperature get close to the limit'),
    'email.event.returned': t('You come back'),
    'email.save': t('Save'),
    'email.saved': t('Saved'),
    'email.test': t('Send a test'),
    'email.testing': t('Sending…'),
    'email.cancel': t('Cancel'),
    'email.passwordStored': t('The password is kept in VS Code\'s secret storage, never in settings.'),

    'actions.log': t('Show log'),
  };
}

function prefix(p: string, record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [p + k, v]));
}

function mapValues<T, U>(record: Record<string, T>, fn: (value: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fn(v)]));
}
