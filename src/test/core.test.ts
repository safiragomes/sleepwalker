import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActivityTracker } from '../core/activity';
import { renderEmail } from '../core/emailTemplate';
import { Translate } from '../core/labels';
import {
  detectDesktop,
  isWatchedProcess,
  parseGnomeIdle,
  parseLidState,
  parseMilliCelsius,
  parseProcStat,
  parseXprintidle,
} from '../core/linux';
import { applyCommands, parseAcDc, parseActiveScheme, POWER_SETTINGS, restoreScript } from '../core/powercfg';
import { evaluateGuardrails, formatClock, formatDuration, SessionRecorder } from '../core/session';
import { SystemStatus } from '../core/types';

const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m));

// ---------------------------------------------------------------------------
// powercfg
// ---------------------------------------------------------------------------

describe('powercfg parsing', () => {
  it('reads the active scheme in any language', () => {
    assert.equal(
      parseActiveScheme('Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)'),
      '381b4222-f694-41f0-9685-ff5bb260df2e',
    );
    assert.equal(
      parseActiveScheme('GUID do Esquema de Energia: 381B4222-F694-41F0-9685-FF5BB260DF2E  (Equilibrado)'),
      '381b4222-f694-41f0-9685-ff5bb260df2e',
    );
    assert.throws(() => parseActiveScheme('nothing here'));
  });

  it('reads AC/DC values of an enumerated setting (lid action)', () => {
    const output = `
Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (Power buttons and lid)
    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)
      Possible Setting Index: 000
      Possible Setting Friendly Name: Do nothing
      Possible Setting Index: 001
      Possible Setting Friendly Name: Sleep
      Possible Setting Index: 002
      Possible Setting Friendly Name: Hibernate
      Possible Setting Index: 003
      Possible Setting Friendly Name: Shut down
    Current AC Power Setting Index: 0x00000001
    Current DC Power Setting Index: 0x00000002
`;
    assert.deepEqual(parseAcDc(output), { ac: 1, dc: 2 });
  });

  it('reads AC/DC values of a range setting (sleep after), ignoring min/max', () => {
    const output = `
    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Dormir após)
      Configuração Mínima Possível: 0x00000000
      Configuração Máxima Possível: 0xffffffff
      Incremento de Configurações Possíveis: 0x00000001
      Unidades de Configurações Possíveis: Segundos
    Índice de Configuração de Energia CA Atual: 0x00000708
    Índice de Configuração de Energia CC Atual: 0x00000384
`;
    assert.deepEqual(parseAcDc(output), { ac: 1800, dc: 900 });
  });

  it('writes a restore script that puts every value back and removes itself', () => {
    const lid = POWER_SETTINGS[0];
    const script = restoreScript('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', [
      { key: 'lid', subgroup: lid.subgroup, setting: lid.setting, ac: 1, dc: 1 },
    ]);
    assert.match(script, /powercfg \/setacvalueindex aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee 4f971e89\S+ 5ca83367\S+ 1\r\n/);
    assert.match(script, /powercfg \/setactive aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
    assert.match(script, /reg delete .*RunOnce" \/v SleepwalkerRestore/);
    assert.match(script, /del "%~f0"/);
    assert.ok(script.includes('\r\n'), 'uses Windows line endings');
  });

  it('re-applies the scheme after writing values', () => {
    const commands = applyCommands('s', [{ key: 'lid', subgroup: 'g', setting: 'x', ac: 0, dc: 0 }]);
    assert.deepEqual(commands.at(-1), ['/setactive', 's']);
    assert.equal(commands.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Linux parsers
// ---------------------------------------------------------------------------

describe('linux parsing', () => {
  it('reads the lid state', () => {
    assert.equal(parseLidState('state:      open\n'), true);
    assert.equal(parseLidState('state:      closed\n'), false);
    assert.equal(parseLidState(''), null);
  });

  it('parses /proc/<pid>/stat even when the name has spaces and parentheses', () => {
    const fields = ['S', '1', '2', '3', '0', '-1', '4194560', '100', '0', '0', '0', '250', '50', '0', '0'];
    const stat = parseProcStat(`1234 (my (weird) name) ${fields.join(' ')}`);
    assert.deepEqual(stat, { comm: 'my (weird) name', ticks: 300 });
  });

  it('recognizes agents by name and through interpreters', () => {
    const watched = ['claude', 'codex', 'aider'];
    assert.ok(isWatchedProcess('claude', ['claude'], watched));
    assert.ok(isWatchedProcess('node', ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'], watched));
    assert.ok(isWatchedProcess('python3.12', ['python3.12', '/home/me/.local/bin/aider'], watched));
    assert.ok(!isWatchedProcess('node', ['node', '/srv/app/server.js'], watched));
    assert.ok(!isWatchedProcess('bash', ['bash', '-c', 'claude'], watched));
    assert.ok(isWatchedProcess('a-very-long-age', [], ['a-very-long-agent-name']), 'comm is truncated to 15 chars');
  });

  it('parses idle times and temperatures', () => {
    assert.equal(parseXprintidle('12345\n'), 12345);
    assert.equal(parseXprintidle('oops'), null);
    assert.equal(parseGnomeIdle('(uint64 9876,)\n'), 9876);
    assert.equal(parseMilliCelsius('54000\n'), 54);
    assert.equal(parseMilliCelsius('-273000'), null);
  });

  it('detects the desktop', () => {
    assert.equal(detectDesktop({ XDG_SESSION_TYPE: 'x11' }), 'x11');
    assert.equal(detectDesktop({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), 'gnome-wayland');
    assert.equal(detectDesktop({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' }), 'kde-wayland');
    assert.equal(detectDesktop({ WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'sway' }), 'other-wayland');
    assert.equal(detectDesktop({}), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

describe('activity tracker', () => {
  it('is busy while a terminal command runs and finishes after the idle window', () => {
    const tracker = new ActivityTracker(0, 5);
    const command = {};
    tracker.commandStarted(command, 1_000);
    assert.equal(tracker.isBusy(), true);
    assert.equal(tracker.isFinished(1_000_000, 60_000), false, 'never finished while busy');
    tracker.commandEnded(command, 100_000);
    assert.equal(tracker.isFinished(150_000, 60_000), false);
    assert.equal(tracker.isFinished(160_000, 60_000), true);
    assert.equal(tracker.commandsStarted, 1);
  });

  it('uses CPU of watched processes against the threshold', () => {
    const tracker = new ActivityTracker(0, 5);
    tracker.cpuSample(100, 0);
    tracker.cpuSample(102, 10_000); // 2 s of CPU in 10 s = 20 %
    assert.equal(tracker.cpuPercent, 20);
    assert.equal(tracker.isBusy(), true);
    tracker.cpuSample(102.1, 20_000); // 1 %
    assert.equal(tracker.isBusy(), false);
    assert.equal(tracker.lastActivityAt, 10_000);
  });

  it('ignores CPU readings that go down when a process exits', () => {
    const tracker = new ActivityTracker(0, 5);
    tracker.cpuSample(500, 0);
    tracker.cpuSample(3, 10_000);
    assert.equal(tracker.cpuPercent, 0);
    assert.equal(tracker.isBusy(), false);
  });

  it('ignores the end of a command it never saw start', () => {
    const tracker = new ActivityTracker(0, 5);
    tracker.commandEnded({}, 500_000);
    assert.equal(tracker.lastActivityAt, 0);
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

describe('guardrails', () => {
  const config = { minBatteryPercent: 15, maxTemperatureC: 90, maxHours: 8 };
  const status = (s: Partial<SystemStatus>): SystemStatus => ({
    batteryPercent: null,
    onAc: null,
    temperatureC: null,
    watchedCpuSeconds: null,
    watchedProcessCount: 0,
    ...s,
  });

  it('warns once near the battery limit and stops at it', () => {
    const memory = { batteryWarned: false, temperatureWarned: false };
    assert.deepEqual(evaluateGuardrails(status({ batteryPercent: 24, onAc: false }), config, memory, 0), {
      kind: 'warn',
      reason: 'battery',
      value: 24,
    });
    assert.deepEqual(evaluateGuardrails(status({ batteryPercent: 22, onAc: false }), config, memory, 0), { kind: 'ok' });
    assert.equal(evaluateGuardrails(status({ batteryPercent: 15, onAc: false }), config, memory, 0).kind, 'stop');
  });

  it('ignores the battery while plugged in', () => {
    const memory = { batteryWarned: false, temperatureWarned: false };
    assert.equal(evaluateGuardrails(status({ batteryPercent: 5, onAc: true }), config, memory, 0).kind, 'ok');
  });

  it('handles temperature and can be turned off', () => {
    const memory = { batteryWarned: false, temperatureWarned: false };
    assert.equal(evaluateGuardrails(status({ temperatureC: 86 }), config, memory, 0).kind, 'warn');
    assert.equal(evaluateGuardrails(status({ temperatureC: 91 }), config, memory, 0).kind, 'stop');
    assert.equal(
      evaluateGuardrails(status({ temperatureC: 99 }), { ...config, maxTemperatureC: 0 }, memory, 0).kind,
      'ok',
    );
  });

  it('enforces the time limit even without status', () => {
    const memory = { batteryWarned: false, temperatureWarned: false };
    assert.deepEqual(evaluateGuardrails(null, config, memory, 8 * 3_600_000), {
      kind: 'stop',
      reason: 'timeLimit',
      value: 8,
    });
  });
});

// ---------------------------------------------------------------------------
// Session record & formatting
// ---------------------------------------------------------------------------

describe('session recorder', () => {
  it('adds up lid-closed time and builds a summary', () => {
    const r = new SessionRecorder('whileAgent', 0, null);
    r.lid(true, 0);
    r.lid(false, 10_000);
    r.status({ batteryPercent: 90, onAc: false, temperatureC: 50, watchedCpuSeconds: null, watchedProcessCount: 0 });
    r.agent(true, 20_000);
    r.agent(true, 25_000); // no duplicate entry
    r.lid(true, 70_000);
    r.status({ batteryPercent: 80, onAc: false, temperatureC: 65, watchedCpuSeconds: null, watchedProcessCount: 0 });
    r.lid(false, 80_000);
    const summary = r.finish('agentFinished', 100_000, 4, 90_000);
    assert.equal(summary.lidClosedMs, 60_000 + 20_000);
    assert.equal(summary.batteryStart, 90);
    assert.equal(summary.batteryEnd, 80);
    assert.equal(summary.temperatureMax, 65);
    assert.deepEqual(
      summary.timeline.map((e) => e.kind),
      ['started', 'lidClosed', 'agentBusy', 'lidOpened', 'lidClosed', 'ended'],
    );
  });

  it('formats durations and clocks', () => {
    assert.equal(formatDuration(9_000), '9s');
    assert.equal(formatDuration(65_000), '1m 05s');
    assert.equal(formatDuration(3_725_000), '1h 02m');
    assert.equal(formatClock(65_000), '01:05');
    assert.equal(formatClock(3_725_000), '1:02:05');
  });
});

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

describe('e-mail template', () => {
  const ctx = { t, host: 'my-<laptop>', time: (at: number) => `T${at}` };

  it('renders an end-of-session e-mail with escaped content', () => {
    const r = new SessionRecorder('timer', 0, 3_600_000);
    const summary = r.finish('agentFinished', 3_600_000, 7, null);
    const email = renderEmail({ kind: 'ended', summary, endAction: 'sleep', willActOnMachine: true }, ctx);
    assert.match(email.subject, /The agent finished/);
    assert.match(email.text, /The computer is going to sleep now\./);
    assert.match(email.text, /Commands run: 7/);
    assert.ok(email.html.includes('my-&lt;laptop&gt;'), 'host is escaped');
    assert.ok(!email.html.includes('my-<laptop>'));
  });

  it('renders warnings and tests', () => {
    assert.match(
      renderEmail({ kind: 'warning', reason: 'battery', value: 21, elapsedMs: 60_000 }, ctx).subject,
      /Battery at 21%/,
    );
    assert.match(renderEmail({ kind: 'test' }, ctx).html, /E-mail notifications work/);
  });
});
