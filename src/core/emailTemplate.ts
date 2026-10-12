import { endActionLabel, endHeadline, modeLabel, timelineLabel, Translate } from './labels';
import { formatDuration, SessionSummary } from './session';
import { EndAction, EndReason } from './types';

export type EmailContent =
  | { kind: 'started'; mode: SessionSummary['mode']; timerMs: number | null; startedAt: number }
  | { kind: 'warning'; reason: 'battery' | 'temperature'; value: number; elapsedMs: number }
  | { kind: 'ended'; summary: SessionSummary; endAction: EndAction; willActOnMachine: boolean }
  | { kind: 'test' };

export interface EmailContext {
  t: Translate;
  host: string;
  /** Formats a timestamp as a local clock time. */
  time: (at: number) => string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Tone = 'calm' | 'good' | 'warn' | 'bad';

const TONE: Record<Tone, { accent: string; soft: string; ink: string }> = {
  calm: { accent: '#7c6cf0', soft: '#efedfd', ink: '#3f3591' },
  good: { accent: '#2f9e6e', soft: '#e6f5ee', ink: '#1d6347' },
  warn: { accent: '#d08a16', soft: '#fbf1df', ink: '#7a4f08' },
  bad: { accent: '#d0493f', soft: '#fbe9e7', ink: '#8a2b24' },
};

function toneFor(reason: EndReason): Tone {
  switch (reason) {
    case 'agentFinished':
    case 'returned':
    case 'manual':
    case 'timerEnded':
      return 'good';
    case 'timeLimit':
    case 'battery':
    case 'temperature':
      return 'warn';
    case 'error':
      return 'bad';
    default:
      return 'calm';
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Stat {
  label: string;
  value: string;
}

function statGrid(stats: Stat[]): string {
  const rows: string[] = [];
  for (let i = 0; i < stats.length; i += 2) {
    const cells = stats.slice(i, i + 2).map(
      (s) => `
        <td width="50%" valign="top" style="padding:6px;">
          <div style="background:#f7f6fc;border-radius:12px;padding:14px 16px;">
            <div style="font-size:12px;color:#77738f;letter-spacing:.02em;">${esc(s.label)}</div>
            <div style="font-size:20px;font-weight:600;color:#1e1b33;margin-top:4px;">${esc(s.value)}</div>
          </div>
        </td>`,
    );
    if (cells.length === 1) cells.push('<td width="50%" style="padding:6px;"></td>');
    rows.push(`<tr>${cells.join('')}</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px -6px 0;">${rows.join('')}</table>`;
}

function layout(options: {
  tone: Tone;
  eyebrow: string;
  headline: string;
  lead: string;
  body: string;
  footer: string;
}): string {
  const tone = TONE[options.tone];
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(options.headline)}</title></head>
<body style="margin:0;padding:0;background:#eeedf5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eeedf5;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
    <tr><td style="background:#16142b;border-radius:18px 18px 0 0;padding:22px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:15px;font-weight:600;color:#ece9ff;letter-spacing:.01em;">
          <span style="display:inline-block;width:26px;height:26px;border-radius:50%;background:#2a2650;color:#f6d77a;text-align:center;line-height:26px;font-size:15px;margin-right:8px;">&#9790;</span>Sleepwalker
        </td>
        <td align="right" style="font-size:12px;color:#8f8ab8;">${esc(options.eyebrow)}</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#ffffff;padding:28px;border-radius:0 0 18px 18px;">
      <div style="display:inline-block;background:${tone.soft};color:${tone.ink};font-size:12px;font-weight:600;padding:5px 10px;border-radius:999px;">${esc(options.eyebrow)}</div>
      <h1 style="margin:14px 0 6px;font-size:24px;line-height:1.25;color:#1e1b33;">${esc(options.headline)}</h1>
      <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#4b4766;">${options.lead}</p>
      <div style="height:4px;width:44px;background:${tone.accent};border-radius:4px;margin:4px 0 14px;"></div>
      ${options.body}
    </td></tr>
    <tr><td align="center" style="padding:16px 12px 0;font-size:12px;line-height:1.5;color:#8a87a0;">${options.footer}</td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function timelineHtml(summary: SessionSummary, ctx: EmailContext): string {
  const items = summary.timeline
    .map(
      (e) => `
      <tr>
        <td width="64" valign="top" style="padding:6px 0;font-size:13px;color:#77738f;font-variant-numeric:tabular-nums;">${esc(ctx.time(e.at))}</td>
        <td width="18" valign="top" style="padding:11px 0 0;"><div style="width:8px;height:8px;border-radius:50%;background:${
          e.kind === 'ended' ? TONE[toneFor(summary.endReason)].accent : '#c9c4f2'
        };"></div></td>
        <td valign="top" style="padding:6px 0;font-size:14px;color:#2d2945;">${esc(timelineLabel(e, ctx.t))}</td>
      </tr>`,
    )
    .join('');
  return `
    <div style="margin-top:22px;font-size:13px;font-weight:600;color:#1e1b33;">${esc(ctx.t('Timeline'))}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">${items}</table>`;
}

function batteryText(summary: SessionSummary): string {
  if (summary.batteryStart === null) return '—';
  if (summary.batteryEnd === null || summary.batteryEnd === summary.batteryStart) return `${summary.batteryStart}%`;
  return `${summary.batteryStart}% → ${summary.batteryEnd}%`;
}

export function renderEmail(content: EmailContent, ctx: EmailContext): RenderedEmail {
  const { t } = ctx;
  const footer = esc(t('Sent by Sleepwalker from {0}. You can change which e-mails you get in the Sleepwalker panel.', ctx.host));

  switch (content.kind) {
    case 'test': {
      const headline = t('E-mail notifications work');
      const lead = esc(t('This is a test from {0}. From now on, Sleepwalker will write to you here when something happens while you are away.', ctx.host));
      return {
        subject: `☾ ${headline}`,
        text: `${headline}\n\n${t('This is a test from {0}. From now on, Sleepwalker will write to you here when something happens while you are away.', ctx.host)}`,
        html: layout({ tone: 'good', eyebrow: t('Test'), headline, lead, body: '', footer }),
      };
    }

    case 'started': {
      const headline = t('Sleepwalking on {0}', ctx.host);
      const mode = modeLabel(content.mode, t, content.timerMs);
      const lead = esc(t('Started at {0}. Mode: {1}. You can close the lid; the agents keep working.', ctx.time(content.startedAt), mode));
      return {
        subject: `☾ ${headline}`,
        text: `${headline}\n\n${t('Started at {0}. Mode: {1}. You can close the lid; the agents keep working.', ctx.time(content.startedAt), mode)}`,
        html: layout({ tone: 'calm', eyebrow: t('Started'), headline, lead, body: '', footer }),
      };
    }

    case 'warning': {
      const headline =
        content.reason === 'battery'
          ? t('Battery at {0}% on {1}', content.value, ctx.host)
          : t('{0} is at {1} °C', ctx.host, Math.round(content.value));
      const leadText =
        content.reason === 'battery'
          ? t('Sleepwalker will put the computer to sleep if the battery keeps dropping. Plug it in to keep the agents running.')
          : t('Sleepwalker will put the computer to sleep if it keeps heating up. Take it out of the bag or give it some air.');
      const body = statGrid([{ label: t('Sleepwalking for'), value: formatDuration(content.elapsedMs) }]);
      return {
        subject: `⚠ ${headline}`,
        text: `${headline}\n\n${leadText}`,
        html: layout({ tone: 'warn', eyebrow: t('Warning'), headline, lead: esc(leadText), body, footer }),
      };
    }

    case 'ended': {
      const s = content.summary;
      const headline = endHeadline(s.endReason, t);
      const parts = [t('Ended at {0} on {1}.', ctx.time(s.endedAt), ctx.host)];
      if (content.willActOnMachine) parts.push(endActionLabel(content.endAction, t));
      const lead = parts.join(' ');
      const stats: Stat[] = [
        { label: t('Duration'), value: formatDuration(s.durationMs) },
        { label: t('Lid closed'), value: s.lidClosedMs > 0 ? formatDuration(s.lidClosedMs) : '—' },
        { label: t('Battery'), value: batteryText(s) },
        { label: t('Peak temperature'), value: s.temperatureMax !== null ? `${Math.round(s.temperatureMax)} °C` : '—' },
        { label: t('Commands run'), value: String(s.commandsStarted) },
        { label: t('Mode'), value: modeLabel(s.mode, t, s.timerMs) },
      ];
      const icon = s.endReason === 'agentFinished' ? '✓' : s.endReason === 'error' ? '✕' : '☾';
      const text = [
        headline,
        '',
        lead,
        '',
        ...stats.map((x) => `${x.label}: ${x.value}`),
        '',
        `${t('Timeline')}:`,
        ...s.timeline.map((e) => `  ${ctx.time(e.at)}  ${timelineLabel(e, t)}`),
      ].join('\n');
      return {
        subject: `${icon} ${headline} · ${ctx.host}`,
        text,
        html: layout({
          tone: toneFor(s.endReason),
          eyebrow: t('Session summary'),
          headline,
          lead: esc(lead),
          body: statGrid(stats) + timelineHtml(s, ctx),
          footer,
        }),
      };
    }
  }
}
