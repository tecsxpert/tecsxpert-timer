import * as vscode from 'vscode';
import { StorageManager } from './StorageManager';
import { TimerManager } from './TimerManager';
import { StatusBarController } from './StatusBar';
import { SidebarProvider } from './SidebarProvider';
import { DashboardPanel } from './DashboardPanel';
import { ApiClient } from './ApiClient';
import { IntegrationManager } from './integrations/IntegrationManager';

let syncTimer: ReturnType<typeof setInterval> | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const storage     = new StorageManager(ctx);
  const timer       = new TimerManager(storage);
  const status      = new StatusBarController();
  const api         = new ApiClient();
  const integrations = new IntegrationManager(ctx.secrets);

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const sidebar = new SidebarProvider(timer, storage, ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('tecsxpert-timer.sidebar', sidebar)
  );

  // ── Status bar ────────────────────────────────────────────────────────────
  timer.on('tick',          s => status.update(s));
  timer.on('statusChanged', s => status.update(s));

  // ── Auto-log time to integration when session is saved ────────────────────
  timer.on('sessionSaved', async (session) => {
    scheduleImmediateSync(api, storage);

    if (session.linkedTask) {
      const logged = await integrations.logSessionTime(session.linkedTask, session.duration, session.projectName);
      if (logged) {
        storage.markTimeLogged(session.id);
        const label = session.linkedTask.integration === 'jira'
          ? session.linkedTask.taskKey
          : session.linkedTask.taskTitle;
        vscode.window.showInformationMessage(`Time logged to ${session.linkedTask.integration}: ${label}`);
      }
      // Clear linked task after stop — next session starts fresh
      sidebar.pushLinkedTask(undefined);
    }
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('tecsxpert-timer.start', () => {
      timer.start();
    }),

    vscode.commands.registerCommand('tecsxpert-timer.pause', () => {
      timer.getState() === 'paused' ? timer.start() : timer.pause();
    }),

    vscode.commands.registerCommand('tecsxpert-timer.stop', () => {
      timer.stop();
    }),

    vscode.commands.registerCommand('tecsxpert-timer.openDashboard', () => {
      DashboardPanel.show(ctx, storage, timer, api);
    }),

    vscode.commands.registerCommand('tecsxpert-timer.switchProject', async () => {
      const ws = vscode.workspace.workspaceFolders ?? [];
      const items: vscode.QuickPickItem[] = [
        ...ws.map(f => ({ label: f.name, description: f.uri.fsPath, iconPath: new vscode.ThemeIcon('folder') })),
        { label: '$(pencil) Custom name…', description: 'Type a project name manually' },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: 'Switch Project' });
      if (!pick) { return; }
      if (pick.label.startsWith('$(pencil)')) {
        const name = await vscode.window.showInputBox({ prompt: 'Project name', value: timer.getStatus().projectName });
        if (name) { timer.stop(); timer.start(name, ''); }
      } else if (pick.description) {
        timer.stop();
        timer.start(pick.label, pick.description);
      }
    }),

    vscode.commands.registerCommand('tecsxpert-timer.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Tecsxpert API key',
        password: true,
        placeHolder: 'sk-txpert-…',
        value: vscode.workspace.getConfiguration('tecsxpert-timer').get<string>('apiKey', ''),
      });
      if (key === undefined) { return; }
      await vscode.workspace.getConfiguration('tecsxpert-timer').update('apiKey', key, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(key ? 'API key saved. Syncing…' : 'API key cleared.');
      if (key) { scheduleImmediateSync(api, storage); }
    }),

    vscode.commands.registerCommand('tecsxpert-timer.syncNow', async () => {
      const n = await runSync(api, storage);
      if (n === null)  { vscode.window.showWarningMessage('No API key — run "Set API Key" first.'); }
      else if (n === 0){ vscode.window.showInformationMessage('Nothing new to sync.'); }
      else             { vscode.window.showInformationMessage(`Synced ${n} session(s).`); }
    }),

    // ── Integration commands ────────────────────────────────────────────────

    vscode.commands.registerCommand('tecsxpert-timer.linkTask', async () => {
      const task = await integrations.pickTask();
      if (!task) { return; }
      timer.setLinkedTask(task);
      sidebar.pushLinkedTask(task);
      const label = task.integration === 'jira' ? task.taskKey : task.taskTitle;
      vscode.window.showInformationMessage(`Linked to ${task.integration}: ${label}`);
    }),

    vscode.commands.registerCommand('tecsxpert-timer.unlinkTask', () => {
      timer.setLinkedTask(undefined);
      sidebar.pushLinkedTask(undefined);
      vscode.window.showInformationMessage('Task unlinked.');
    }),

    vscode.commands.registerCommand('tecsxpert-timer.setupJira', () => {
      integrations.setupJira();
    }),

    vscode.commands.registerCommand('tecsxpert-timer.setupClickUp', () => {
      integrations.setupClickUp();
    }),

    vscode.commands.registerCommand('tecsxpert-timer.setupMonday', () => {
      integrations.setupMonday();
    }),
  );

  // ── Auto-start (after remote config is applied) ───────────────────────────
  applyRemoteConfig(api, timer).then(() => {
    const cfg = vscode.workspace.getConfiguration('tecsxpert-timer');
    if (cfg.get<boolean>('autoStart', false)) {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws && timer.getState() === 'idle') { timer.start(ws.name, ws.uri.fsPath); }
    }
  }).catch(() => {
    // offline — respect local setting
    const cfg = vscode.workspace.getConfiguration('tecsxpert-timer');
    if (cfg.get<boolean>('autoStart', false)) {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws && timer.getState() === 'idle') { timer.start(ws.name, ws.uri.fsPath); }
    }
  });

  // ── Sync loop ─────────────────────────────────────────────────────────────
  restartSyncLoop(api, storage, vscode.workspace.getConfiguration('tecsxpert-timer').get<number>('syncIntervalMinutes', 5));

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('tecsxpert-timer.syncIntervalMinutes')) {
        const mins = vscode.workspace.getConfiguration('tecsxpert-timer').get<number>('syncIntervalMinutes', 5);
        restartSyncLoop(api, storage, mins);
      }
      if (e.affectsConfiguration('tecsxpert-timer.showInStatusBar')) {
        status.update(timer.getStatus());
      }
    })
  );

  // remote config applied above in auto-start block

  ctx.subscriptions.push(new vscode.Disposable(() => {
    clearSyncLoop();
    timer.dispose();
    status.dispose();
  }));
}

export function deactivate(): void { clearSyncLoop(); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function restartSyncLoop(api: ApiClient, storage: StorageManager, mins: number): void {
  clearSyncLoop();
  syncTimer = setInterval(() => runSync(api, storage), Math.max(1, mins) * 60_000);
}

function clearSyncLoop(): void {
  if (syncTimer !== undefined) { clearInterval(syncTimer); syncTimer = undefined; }
}

function scheduleImmediateSync(api: ApiClient, storage: StorageManager): void {
  setTimeout(() => runSync(api, storage), 2000);
}

async function runSync(api: ApiClient, storage: StorageManager): Promise<number | null> {
  if (!api.isConfigured()) { return null; }
  const unsynced = storage.getUnsynced();
  if (!unsynced.length) { return 0; }
  try {
    const synced = await api.syncSessions(unsynced);
    if (synced.length) { storage.markSynced(synced); }
    return synced.length;
  } catch { return 0; }
}

async function applyRemoteConfig(api: ApiClient, timer?: TimerManager): Promise<void> {
  const remote = await api.getRemoteConfig();
  if (!remote?.data) { return; }
  const d = remote.data;
  const cfg = vscode.workspace.getConfiguration('tecsxpert-timer');
  if (d.idleThresholdMinutes !== undefined) {
    await cfg.update('idleThresholdMinutes', d.idleThresholdMinutes, vscode.ConfigurationTarget.Global);
  }
  if (d.dailyGoalMinutes !== undefined) {
    await cfg.update('dailyGoalMinutes', d.dailyGoalMinutes, vscode.ConfigurationTarget.Global);
  }
  if (d.autoStart !== undefined) {
    await cfg.update('autoStart', d.autoStart, vscode.ConfigurationTarget.Global);
  }
}
