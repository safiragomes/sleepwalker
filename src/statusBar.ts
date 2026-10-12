import * as vscode from 'vscode';
import { Controller } from './controller';
import { formatClock } from './core/session';

/** The always-visible entry point: one click to start or wake up. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('sleepwalker.status', vscode.StatusBarAlignment.Right, 1000);
  private readonly clock: NodeJS.Timeout;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly controller: Controller) {
    this.item.name = 'Sleepwalker';
    this.item.command = 'sleepwalker.toggle';
    this.subscription = controller.onDidChange(() => this.render());
    this.clock = setInterval(() => {
      if (controller.isActive) this.render();
    }, 1_000);
    this.render();
    this.item.show();
  }

  private render(): void {
    const view = this.controller.view;
    const t = vscode.l10n.t;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.supportThemeIcons = true;

    switch (view.phase) {
      case 'starting':
        this.item.text = `$(loading~spin) ${t('Getting ready…')}`;
        this.item.backgroundColor = undefined;
        tooltip.appendMarkdown(t('Preparing the power settings…'));
        break;
      case 'stopping':
        this.item.text = `$(loading~spin) ${t('Waking up…')}`;
        this.item.backgroundColor = undefined;
        tooltip.appendMarkdown(t('Restoring the power settings…'));
        break;
      case 'active': {
        const live = view.live!;
        const elapsed = formatClock(Date.now() - live.startedAt);
        const agent = live.agentBusy ? '$(pulse)' : '$(eye-closed)';
        this.item.text = `${agent} ${elapsed}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        tooltip.appendMarkdown(`**${t('Sleepwalking')}** · ${this.controller.describeMode(live.mode, live.endsAt ? live.endsAt - live.startedAt : null)}\n\n`);
        tooltip.appendMarkdown(
          live.agentBusy ? `$(pulse) ${t('The agent is working')}\n\n` : `$(circle-outline) ${t('The agent is quiet')}\n\n`,
        );
        if (live.status?.batteryPercent != null) {
          tooltip.appendMarkdown(`$(${live.status.onAc ? 'plug' : 'dashboard'}) ${live.status.batteryPercent}%  `);
        }
        if (live.status?.temperatureC != null) {
          tooltip.appendMarkdown(`$(flame) ${Math.round(live.status.temperatureC)} °C`);
        }
        tooltip.appendMarkdown(`\n\n${t('Click to wake up')}`);
        break;
      }
      default:
        this.item.text = `$(eye) Sleepwalker`;
        this.item.backgroundColor = undefined;
        tooltip.appendMarkdown(`**Sleepwalker**\n\n${t('Turn the screen off and close the lid while your agents keep working.')}\n\n${t('Click to start')}`);
    }
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    clearInterval(this.clock);
    this.subscription.dispose();
    this.item.dispose();
  }
}
