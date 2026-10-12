import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Controller } from './controller';
import { EmailEvent, readSettings, writeSetting } from './config';
import { Mailer } from './email';
import { Mode } from './core/types';
import { panelStrings } from './strings';

type FromWebview =
  | { type: 'ready' }
  | { type: 'start'; mode: Mode; minutes?: number }
  | { type: 'stop' }
  | { type: 'setSetting'; key: 'lockScreen' | 'turnOffDisplay' | 'endAction'; value: unknown }
  | {
      type: 'saveEmail';
      fields: {
        smtpHost: string;
        smtpPort: number;
        smtpSecure: boolean;
        smtpUser: string;
        to: string;
        from: string;
        events: EmailEvent[];
      };
      password?: string;
    }
  | { type: 'setEmailEnabled'; enabled: boolean }
  | { type: 'testEmail' }
  | { type: 'openSettings' }
  | { type: 'showLog' };

const EMAIL_EVENTS: EmailEvent[] = ['started', 'agentFinished', 'timerEnded', 'guardrail', 'warning', 'returned'];
const SETTABLE = new Set(['lockScreen', 'turnOffDisplay', 'endAction']);

/** The Sleepwalker side panel. */
export class PanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'sleepwalker.panel';
  private view: vscode.WebviewView | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingFocusEmail = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionId: string,
    private readonly controller: Controller,
    private readonly mailer: Mailer,
  ) {
    this.disposables.push(
      controller.onDidChange(() => void this.push()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sleepwalker')) void this.push();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: FromWebview) => void this.handle(m), null, this.disposables);
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.push();
    });
    view.onDidDispose(() => (this.view = null));
  }

  /** Opens the panel with the e-mail form expanded. */
  async focusEmail(): Promise<void> {
    this.pendingFocusEmail = true;
    await vscode.commands.executeCommand(`${PanelProvider.viewId}.focus`);
    if (this.view) {
      void this.view.webview.postMessage({ type: 'focusEmail' });
      this.pendingFocusEmail = false;
    }
  }

  private async push(): Promise<void> {
    if (!this.view) return;
    const settings = readSettings();
    await this.view.webview.postMessage({
      type: 'state',
      view: this.controller.view,
      now: Date.now(),
      settings: {
        lockScreen: settings.lockScreen,
        turnOffDisplay: settings.turnOffDisplay,
        endAction: settings.endAction,
        idleMinutes: settings.agent.idleMinutes,
        minBatteryPercent: settings.guardrails.minBatteryPercent,
        maxTemperatureC: settings.guardrails.maxTemperatureC,
      },
      email: {
        ...settings.email,
        hasPassword: await this.mailer.hasPassword(),
        complete: (await this.mailer.missing(settings.email)).length === 0,
      },
    });
  }

  private async handle(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.push();
        if (this.pendingFocusEmail) {
          this.pendingFocusEmail = false;
          void this.view?.webview.postMessage({ type: 'focusEmail' });
        }
        break;
      case 'start': {
        const mode: Mode = ['untilReturn', 'whileAgent', 'timer'].includes(message.mode) ? message.mode : 'untilReturn';
        const minutes = Number(message.minutes);
        const timerMs = mode === 'timer' && minutes > 0 ? Math.min(minutes, 48 * 60) * 60_000 : null;
        await this.controller.start(mode, timerMs);
        break;
      }
      case 'stop':
        await this.controller.stop('manual');
        break;
      case 'setSetting':
        if (SETTABLE.has(message.key)) await writeSetting(message.key, message.value);
        break;
      case 'setEmailEnabled':
        await writeSetting('email.enabled', Boolean(message.enabled));
        break;
      case 'saveEmail': {
        const f = message.fields;
        const port = Number(f.smtpPort);
        await writeSetting('email.smtpHost', String(f.smtpHost ?? '').trim());
        await writeSetting('email.smtpPort', Number.isInteger(port) && port > 0 && port < 65536 ? port : 587);
        await writeSetting('email.smtpSecure', Boolean(f.smtpSecure));
        await writeSetting('email.smtpUser', String(f.smtpUser ?? '').trim());
        await writeSetting('email.to', String(f.to ?? '').trim());
        await writeSetting('email.from', String(f.from ?? '').trim());
        await writeSetting(
          'email.events',
          (Array.isArray(f.events) ? f.events : []).filter((e) => EMAIL_EVENTS.includes(e)),
        );
        if (typeof message.password === 'string' && message.password.length > 0) {
          await this.mailer.setPassword(message.password);
        }
        await writeSetting('email.enabled', true);
        void this.view?.webview.postMessage({ type: 'emailResult', ok: true, action: 'save' });
        await this.push();
        break;
      }
      case 'testEmail':
        try {
          await this.mailer.send({ kind: 'test' });
          void this.view?.webview.postMessage({
            type: 'emailResult',
            ok: true,
            action: 'test',
            message: vscode.l10n.t('Test e-mail sent to {0}.', readSettings().email.to),
          });
        } catch (error) {
          void this.view?.webview.postMessage({
            type: 'emailResult',
            ok: false,
            action: 'test',
            message: vscode.l10n.t('The test e-mail failed: {0}', (error as Error).message),
          });
        }
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.extensionId}`);
        break;
      case 'showLog':
        await vscode.commands.executeCommand('sleepwalker.showLog');
        break;
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    const boot = {
      strings: panelStrings(),
      locale: vscode.env.language,
      reducedMotion: vscode.workspace.getConfiguration('workbench').get('reduceMotion') === 'on',
    };
    // JSON is embedded in a <script type="application/json">; "<" is escaped so it can't close the tag.
    const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="${vscode.env.language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Sleepwalker</title>
</head>
<body>
<div id="app" aria-live="polite"></div>
<script type="application/json" id="boot">${bootJson}</script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
