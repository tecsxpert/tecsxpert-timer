import * as vscode from 'vscode';
import { TimerStatus } from './types';

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

export class StatusBarController {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left, 100
    );
    this.item.command = 'tecsxpert-timer.openDashboard';
    this.item.name = 'Tecsxpert Timer';
    this.update({ state: 'idle', projectName: '', workspacePath: '', sessionStart: 0, elapsed: 0, todayTotal: 0 });
    this.item.show();
  }

  update(status: TimerStatus): void {
    const cfg = vscode.workspace.getConfiguration('tecsxpert-timer');
    if (!cfg.get<boolean>('showInStatusBar', true)) {
      this.item.hide();
      return;
    }

    const { state, elapsed, todayTotal, projectName } = status;

    if (state === 'running') {
      this.item.text = `$(clock) ${fmt(elapsed)}  ·  ${projectName}`;
      this.item.tooltip = `Today total: ${fmt(todayTotal)}\nClick to open dashboard`;
      this.item.backgroundColor = undefined;
      this.item.color = new vscode.ThemeColor('statusBar.foreground');
    } else if (state === 'paused') {
      this.item.text = `$(debug-pause) Paused  ·  ${projectName}`;
      this.item.tooltip = `Session paused. Today: ${fmt(todayTotal)}\nClick to open dashboard`;
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.text = `$(clock) Tecsxpert Timer`;
      this.item.tooltip = `Timer idle\nClick to open dashboard`;
      this.item.color = new vscode.ThemeColor('statusBarItem.remoteForeground');
      this.item.backgroundColor = undefined;
    }

    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
