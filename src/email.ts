import * as os from 'os';
import * as vscode from 'vscode';
import { createTransport } from 'nodemailer';
import { EmailContent, renderEmail } from './core/emailTemplate';
import { EmailEvent, EmailSettings, readSettings } from './config';

const PASSWORD_KEY = 'sleepwalker.smtpPassword';

/** Sends notification e-mails over SMTP. The password lives in VS Code's secret storage. */
export class Mailer {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: (message: string) => void,
  ) {}

  async hasPassword(): Promise<boolean> {
    return Boolean(await this.secrets.get(PASSWORD_KEY));
  }

  async setPassword(password: string): Promise<void> {
    if (password) await this.secrets.store(PASSWORD_KEY, password);
    else await this.secrets.delete(PASSWORD_KEY);
  }

  /** Missing pieces, if any. An empty list means "ready to send". */
  async missing(settings: EmailSettings = readSettings().email): Promise<string[]> {
    const missing: string[] = [];
    if (!settings.to) missing.push(vscode.l10n.t('e-mail'));
    if (!settings.smtpHost) missing.push(vscode.l10n.t('server'));
    if (!settings.smtpUser) missing.push(vscode.l10n.t('sending account'));
    if (!(await this.hasPassword())) missing.push(vscode.l10n.t('password'));
    return missing;
  }

  /** Sends only if e-mail is enabled and the user opted in to this kind of event. */
  async notify(event: EmailEvent, content: EmailContent): Promise<void> {
    const settings = readSettings().email;
    if (!settings.enabled || !settings.events.includes(event)) return;
    try {
      await this.send(content, settings);
      this.log(`E-mail sent (${event}).`);
    } catch (error) {
      this.log(`E-mail failed (${event}): ${(error as Error).message}`);
    }
  }

  async send(content: EmailContent, settings: EmailSettings = readSettings().email): Promise<void> {
    const missing = await this.missing(settings);
    if (missing.length > 0) {
      throw new Error(vscode.l10n.t('E-mail is not fully configured. Missing: {0}.', missing.join(', ')));
    }
    const password = (await this.secrets.get(PASSWORD_KEY))!;
    const language = vscode.env.language;
    const rendered = renderEmail(content, {
      t: vscode.l10n.t,
      host: os.hostname(),
      time: (at) => new Date(at).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }),
    });

    const transport = createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.smtpSecure,
      requireTLS: !settings.smtpSecure,
      auth: { user: settings.smtpUser, pass: password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    try {
      await transport.sendMail({
        from: settings.from || `Sleepwalker <${settings.smtpUser}>`,
        to: settings.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
    } finally {
      transport.close();
    }
  }
}

/** Gives up waiting after `ms`, but lets the promise finish in the background. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}
