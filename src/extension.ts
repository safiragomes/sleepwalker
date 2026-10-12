import * as vscode from 'vscode';
import { Controller } from './controller';
import { Mode } from './core/types';
import { Mailer } from './email';
import { PanelProvider } from './panel';
import { createBackend } from './platform';
import { StatusBar } from './statusBar';

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Sleepwalker', { log: true });
  const log = (message: string) => output.info(message);
  context.subscriptions.push(output);

  const backend = createBackend(context.extensionUri.fsPath, context.globalStorageUri.fsPath);
  const mailer = new Mailer(context.secrets, log);
  controller = new Controller(context, backend, mailer, log);
  const panel = new PanelProvider(context.extensionUri, context.extension.id, controller, mailer);
  const ctl = controller;

  context.subscriptions.push(
    controller,
    panel,
    new StatusBar(controller),
    vscode.window.registerWebviewViewProvider(PanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('sleepwalker.start', () => pickAndStart(ctl)),
    vscode.commands.registerCommand('sleepwalker.startUntilReturn', () => ctl.start('untilReturn')),
    vscode.commands.registerCommand('sleepwalker.startWhileAgent', () => ctl.start('whileAgent')),
    vscode.commands.registerCommand('sleepwalker.startTimer', async () => {
      const minutes = await pickDuration();
      if (minutes) await ctl.start('timer', minutes * 60_000);
    }),
    vscode.commands.registerCommand('sleepwalker.stop', () => ctl.stop('manual')),
    vscode.commands.registerCommand('sleepwalker.toggle', () => (ctl.isActive ? ctl.stop('manual') : pickAndStart(ctl))),
    vscode.commands.registerCommand('sleepwalker.configureEmail', () => panel.focusEmail()),
    vscode.commands.registerCommand('sleepwalker.testEmail', () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Sending a test e-mail…') },
        async () => {
          try {
            await mailer.send({ kind: 'test' });
            void vscode.window.showInformationMessage(vscode.l10n.t('Test e-mail sent.'));
          } catch (error) {
            void vscode.window
              .showErrorMessage(
                vscode.l10n.t('The test e-mail failed: {0}', (error as Error).message),
                vscode.l10n.t('Set up e-mail'),
              )
              .then((choice) => {
                if (choice) void panel.focusEmail();
              });
          }
        },
      ),
    ),
    vscode.commands.registerCommand('sleepwalker.showLog', () => output.show()),
  );

  log(`Sleepwalker ${context.extension.packageJSON.version} on ${process.platform}.`);
  if (!backend) {
    log('This operating system is not supported yet; the panel will say so.');
  }
  await controller.recover();
}

export function deactivate(): void {
  controller?.shutdown();
}

async function pickAndStart(ctl: Controller): Promise<void> {
  const t = vscode.l10n.t;
  type Item = vscode.QuickPickItem & { mode: Mode };
  const items: Item[] = [
    {
      mode: 'untilReturn',
      label: `$(debug-step-back) ${t('Until I come back')}`,
      detail: t('Ends when you open the lid or touch the keyboard.'),
    },
    {
      mode: 'whileAgent',
      label: `$(pulse) ${t('While the agent works')}`,
      detail: t('Ends a few minutes after the agent goes quiet.'),
    },
    {
      mode: 'timer',
      label: `$(watch) ${t('For a set time')}`,
      detail: t('Ends after the time you choose.'),
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: t('Start sleepwalking'),
    placeHolder: t('How long should the computer stay awake?'),
  });
  if (!picked) return;
  if (picked.mode === 'timer') {
    const minutes = await pickDuration();
    if (minutes) await ctl.start('timer', minutes * 60_000);
  } else {
    await ctl.start(picked.mode);
  }
}

async function pickDuration(): Promise<number | undefined> {
  const t = vscode.l10n.t;
  const presets = [30, 60, 120, 240, 480];
  type Item = vscode.QuickPickItem & { minutes?: number };
  const items: Item[] = [
    ...presets.map((m) => ({
      minutes: m,
      label: m < 60 ? t('{0} min', m) : t('{0} h', m / 60),
    })),
    { label: `$(edit) ${t('Other…')}` },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: t('For how long?') });
  if (!picked) return undefined;
  if (picked.minutes) return picked.minutes;
  const value = await vscode.window.showInputBox({
    title: t('For how long?'),
    prompt: t('Minutes'),
    value: '90',
    validateInput: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 && n <= 48 * 60 ? undefined : t('Enter a number of minutes between 1 and 2880.');
    },
  });
  return value ? Number(value) : undefined;
}
