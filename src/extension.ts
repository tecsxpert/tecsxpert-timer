import * as vscode from 'vscode';
import { StorageManager } from './StorageManager';
import { TimerManager } from './TimerManager';
import { StatusBarController } from './StatusBar';
import { SidebarProvider } from './SidebarProvider';
import { DashboardPanel } from './DashboardPanel';
import { ApiClient } from './ApiClient';
import { IntegrationManager } from './integrations/IntegrationManager';

let syncTimer: ReturnType<typeof setInterval> | undefined;

// ── GRC Control library (curated set per framework) ───────────────────────────

const GRC_CONTROLS: vscode.QuickPickItem[] = [
  { label: 'ISO 27001:2022',      kind: vscode.QuickPickItemKind.Separator },
  { label: 'ISO27001-A8.8',        description: 'Management of technical vulnerabilities' },
  { label: 'ISO27001-A12.1',       description: 'Operational procedures and responsibilities' },
  { label: 'ISO27001-A14.2',       description: 'Security in development and support processes' },
  { label: 'ISO27001-A15.1',       description: 'Supplier relationship information security' },
  { label: 'ISO27001-A18.1',       description: 'Compliance with legal and contractual requirements' },
  { label: 'SOC 2',               kind: vscode.QuickPickItemKind.Separator },
  { label: 'SOC2-CC6.1',          description: 'Logical and physical access controls' },
  { label: 'SOC2-CC7.2',          description: 'System monitoring' },
  { label: 'SOC2-CC8.1',          description: 'Change management' },
  { label: 'SOC2-CC9.1',          description: 'Risk mitigation' },
  { label: 'NIST CSF 2.0',        kind: vscode.QuickPickItemKind.Separator },
  { label: 'NIST-GV.OC',          description: 'Organizational Context' },
  { label: 'NIST-PR.AT',          description: 'Awareness and Training' },
  { label: 'NIST-PR.IP',          description: 'Information Protection Processes' },
  { label: 'NIST-DE.CM',          description: 'Continuous Monitoring' },
  { label: 'NIST-RS.AN',          description: 'Incident Analysis' },
  { label: 'GDPR',                kind: vscode.QuickPickItemKind.Separator },
  { label: 'GDPR-Art25',          description: 'Data protection by design and by default' },
  { label: 'GDPR-Art32',          description: 'Security of processing' },
  { label: 'GDPR-Art33',          description: 'Notification of personal data breach' },
  { label: 'DPDP Act 2023',       kind: vscode.QuickPickItemKind.Separator },
  { label: 'DPDP-S8',             description: 'General obligations of Data Fiduciary' },
  { label: 'DPDP-S11',            description: 'Right to information about personal data' },
  { label: 'DPDP-S13',            description: 'Obligations on personal data breach' },
  { label: 'PCI-DSS v4.0',        kind: vscode.QuickPickItemKind.Separator },
  { label: 'PCIDSS-6.3',          description: 'Security vulnerabilities identified and addressed' },
  { label: 'PCIDSS-6.4',          description: 'Public-facing web applications protected' },
  { label: 'PCIDSS-8.2',          description: 'User identification and authentication' },
  { label: 'NIST SP 800-53',      kind: vscode.QuickPickItemKind.Separator },
  { label: 'NIST800-SA-11',       description: 'Developer Testing and Evaluation' },
  { label: 'NIST800-CM-3',        description: 'Configuration Change Control' },
  { label: 'NIST800-AU-12',       description: 'Audit Record Generation' },
];

async function showConsentDialog(ctx: vscode.ExtensionContext): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    'Tecsxpert Timer collects session metadata — project name, timestamps, git branch/commit hash, and any GRC controls you tag — and syncs it to your organisation\'s GRC tenant. ' +
    'This data is used to generate audit evidence and is stored only on your tenant. ' +
    'You can withdraw consent at any time by clearing your API key.',
    { modal: true },
    'I Consent',
    'Cancel'
  );
  const consented = choice === 'I Consent';
  await ctx.globalState.update('tecsxpert-timer.consentGiven', consented);
  return consented;
}

async function pickControls(): Promise<string[] | undefined> {
  const picks = await vscode.window.showQuickPick(GRC_CONTROLS, {
    title: 'Tag GRC Controls (optional — Escape to skip)',
    placeHolder: 'Select controls this session addresses',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picks) { return undefined; }
  return picks
    .filter(p => p.kind !== vscode.QuickPickItemKind.Separator)
    .map(p => p.label);
}

export function activate(ctx: vscode.ExtensionContext): void {
  const storage     = new StorageManager(ctx);
  const timer       = new TimerManager(storage);
  const status      = new StatusBarController();
  const api         = new ApiClient();
  const integrations = new IntegrationManager(ctx.secrets);

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const sidebar = new SidebarProvider(timer, storage, ctx, api);
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

    vscode.commands.registerCommand('tecsxpert-timer.stop', async () => {
      if (timer.getState() === 'idle') { return; }

      // Consent gate — one time per API key; re-shown if key changes
      let consentGiven = ctx.globalState.get<boolean>('tecsxpert-timer.consentGiven', false);
      if (!consentGiven && api.isConfigured()) {
        consentGiven = await showConsentDialog(ctx);
        if (!consentGiven) { return; }
      }

      // Control mapping picker — optional, Escape skips
      const controlIds = await pickControls();

      timer.stop({ controlIds: controlIds ?? [], consentGiven });
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
      const prevKey = vscode.workspace.getConfiguration('tecsxpert-timer').get<string>('apiKey', '');
      const key = await vscode.window.showInputBox({
        prompt: 'Tecsxpert API key',
        password: true,
        placeHolder: 'sk-txpert-…',
        value: prevKey,
      });
      if (key === undefined) { return; }

      // Reset consent when API key changes (new tenant = new consent needed)
      if (key !== prevKey) {
        await ctx.globalState.update('tecsxpert-timer.consentGiven', false);
      }

      await vscode.workspace.getConfiguration('tecsxpert-timer').update('apiKey', key, vscode.ConfigurationTarget.Global);

      if (key) {
        // Ask for consent upfront at API key setup time
        const consented = await showConsentDialog(ctx);
        if (consented) {
          scheduleImmediateSync(api, storage);
          vscode.window.showInformationMessage('API key saved. Syncing…');
        } else {
          vscode.window.showWarningMessage('API key saved but data sync is paused until you consent to data collection.');
        }
      } else {
        vscode.window.showInformationMessage('API key cleared.');
      }
      sidebar.refreshAccount();
    }),

    vscode.commands.registerCommand('tecsxpert-timer.syncNow', async () => {
      const n = await runSync(api, storage);
      if (n === null)  { vscode.window.showWarningMessage('No API key — run "Set API Key" first.'); }
      else if (n === 0){ vscode.window.showInformationMessage('Nothing new to sync.'); }
      else             { vscode.window.showInformationMessage(`Synced ${n} session(s).`); }
    }),

    vscode.commands.registerCommand('tecsxpert-timer.exportEvidence', async () => {
      if (!api.isConfigured()) {
        vscode.window.showWarningMessage('No API key — run "Set API Key" first.');
        return;
      }
      const formatPick = await vscode.window.showQuickPick(
        [{ label: 'JSON', description: 'Structured evidence package' }, { label: 'CSV', description: 'Spreadsheet-compatible' }],
        { title: 'Export Evidence Package — choose format' }
      );
      if (!formatPick) { return; }
      const format = formatPick.label.toLowerCase() as 'json' | 'csv';

      try {
        const raw = await api.exportSessions(format);
        const defaultName = `tecsxpert-evidence-${new Date().toISOString().slice(0,10)}.${format}`;
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(defaultName),
          filters: format === 'csv' ? { 'CSV': ['csv'] } : { 'JSON': ['json'] },
          title: 'Save Evidence Package',
        });
        if (!uri) { return; }
        const content = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        const open = await vscode.window.showInformationMessage(
          `Evidence package saved: ${uri.fsPath}`, 'Open File'
        );
        if (open) { await vscode.commands.executeCommand('vscode.open', uri); }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Export failed: ${err?.message ?? String(err)}`);
      }
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
