import * as vscode from 'vscode';
import { JiraClient } from './JiraClient';
import { ClickUpClient } from './ClickUpClient';
import { MondayClient } from './MondayClient';
import { IntegrationType, LinkedTask } from '../types';

const SECRET_KEY: Record<IntegrationType, string> = {
  jira:    'tecsxpert-timer.jira.apiToken',
  clickup: 'tecsxpert-timer.clickup.apiToken',
  monday:  'tecsxpert-timer.monday.apiToken',
};

function cfg() { return vscode.workspace.getConfiguration('tecsxpert-timer'); }

export class IntegrationManager {
  private currentTask?: LinkedTask;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  // ── Current task ──────────────────────────────────────────────────────────

  getCurrentTask(): LinkedTask | undefined { return this.currentTask; }
  setCurrentTask(task: LinkedTask | undefined): void { this.currentTask = task; }

  // ── Secrets ───────────────────────────────────────────────────────────────

  async getToken(type: IntegrationType): Promise<string> {
    return (await this.secrets.get(SECRET_KEY[type])) ?? '';
  }

  async setToken(type: IntegrationType, token: string): Promise<void> {
    await this.secrets.store(SECRET_KEY[type], token);
  }

  async deleteToken(type: IntegrationType): Promise<void> {
    await this.secrets.delete(SECRET_KEY[type]);
  }

  async isConfigured(type: IntegrationType): Promise<boolean> {
    const token = await this.getToken(type);
    if (!token) { return false; }
    if (type === 'jira') {
      return !!(cfg().get<string>('integrations.jira.domain', '') && cfg().get<string>('integrations.jira.email', ''));
    }
    return true;
  }

  // ── Client factories ──────────────────────────────────────────────────────

  async jiraClient(): Promise<JiraClient | null> {
    const token  = await this.getToken('jira');
    const domain = cfg().get<string>('integrations.jira.domain', '');
    const email  = cfg().get<string>('integrations.jira.email', '');
    if (!token || !domain || !email) { return null; }
    return new JiraClient(domain, email, token);
  }

  async clickUpClient(): Promise<ClickUpClient | null> {
    const token = await this.getToken('clickup');
    return token ? new ClickUpClient(token) : null;
  }

  async mondayClient(): Promise<MondayClient | null> {
    const token = await this.getToken('monday');
    return token ? new MondayClient(token) : null;
  }

  // ── Setup wizards ─────────────────────────────────────────────────────────

  async setupJira(): Promise<boolean> {
    const domain = await vscode.window.showInputBox({
      title: 'Connect Jira (1/3)',
      prompt: 'Your Jira domain (without .atlassian.net)',
      placeHolder: 'mycompany',
      value: cfg().get<string>('integrations.jira.domain', ''),
    });
    if (!domain) { return false; }

    const email = await vscode.window.showInputBox({
      title: 'Connect Jira (2/3)',
      prompt: 'Atlassian account email',
      placeHolder: 'you@company.com',
      value: cfg().get<string>('integrations.jira.email', ''),
    });
    if (!email) { return false; }

    const token = await vscode.window.showInputBox({
      title: 'Connect Jira (3/3)',
      prompt: 'API token — create one at id.atlassian.com → Security → API Tokens',
      password: true,
      placeHolder: 'ATATT3x…',
    });
    if (!token) { return false; }

    await cfg().update('integrations.jira.domain', domain, vscode.ConfigurationTarget.Global);
    await cfg().update('integrations.jira.email',  email,  vscode.ConfigurationTarget.Global);
    await this.setToken('jira', token);

    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing Jira connection…' },
      () => new JiraClient(domain, email, token).testConnection()
    );
    if (ok) {
      vscode.window.showInformationMessage(`Jira connected to ${domain}.atlassian.net`);
    } else {
      vscode.window.showErrorMessage('Jira connection failed — check domain, email, and API token.');
      await this.deleteToken('jira');
    }
    return ok;
  }

  async setupClickUp(): Promise<boolean> {
    const token = await vscode.window.showInputBox({
      title: 'Connect ClickUp',
      prompt: 'Personal API token — from app.clickup.com → Settings → Apps',
      password: true,
      placeHolder: 'pk_…',
    });
    if (!token) { return false; }

    await this.setToken('clickup', token);
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing ClickUp connection…' },
      () => new ClickUpClient(token).testConnection()
    );
    if (ok) {
      // Reset cached workspace so it's re-picked on first use
      await cfg().update('integrations.clickup.workspaceId', '', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('ClickUp connected!');
    } else {
      vscode.window.showErrorMessage('ClickUp connection failed — check your API token.');
      await this.deleteToken('clickup');
    }
    return ok;
  }

  async setupMonday(): Promise<boolean> {
    const token = await vscode.window.showInputBox({
      title: 'Connect Monday.com',
      prompt: 'API token — from monday.com → Profile → Developers → My API Token',
      password: true,
      placeHolder: 'eyJhbGci…',
    });
    if (!token) { return false; }

    await this.setToken('monday', token);
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing Monday.com connection…' },
      () => new MondayClient(token).testConnection()
    );
    if (ok) {
      await cfg().update('integrations.monday.boardId', '', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Monday.com connected!');
    } else {
      vscode.window.showErrorMessage('Monday.com connection failed — check your API token.');
      await this.deleteToken('monday');
    }
    return ok;
  }

  // ── Unified task picker ───────────────────────────────────────────────────

  async pickTask(): Promise<LinkedTask | undefined> {
    const [jConf, cConf, mConf] = await Promise.all([
      this.isConfigured('jira'),
      this.isConfigured('clickup'),
      this.isConfigured('monday'),
    ]);

    if (!jConf && !cConf && !mConf) {
      const choice = await vscode.window.showInformationMessage(
        'No integrations configured yet. Connect Jira, ClickUp, or Monday.com first.',
        'Connect Jira', 'Connect ClickUp', 'Connect Monday.com'
      );
      if (choice === 'Connect Jira')       { await this.setupJira(); }
      if (choice === 'Connect ClickUp')    { await this.setupClickUp(); }
      if (choice === 'Connect Monday.com') { await this.setupMonday(); }
      return undefined;
    }

    const options: vscode.QuickPickItem[] = [];
    if (jConf) { options.push({ label: '$(issues) Jira',        description: cfg().get<string>('integrations.jira.domain', '') + '.atlassian.net' }); }
    if (cConf) { options.push({ label: '$(checklist) ClickUp',  description: 'Search tasks' }); }
    if (mConf) { options.push({ label: '$(calendar) Monday.com', description: 'Search items' }); }

    const chosen = options.length === 1
      ? options[0]
      : await vscode.window.showQuickPick(options, { title: 'Link Task — Choose Integration' });
    if (!chosen) { return undefined; }

    if (chosen.label.includes('Jira'))       { return this.pickJiraIssue(); }
    if (chosen.label.includes('ClickUp'))    { return this.pickClickUpTask(); }
    if (chosen.label.includes('Monday.com')) { return this.pickMondayItem(); }
    return undefined;
  }

  private async pickJiraIssue(): Promise<LinkedTask | undefined> {
    const client = await this.jiraClient();
    if (!client) { return undefined; }

    const query = await vscode.window.showInputBox({
      title: 'Search Jira',
      prompt: 'Search by key (e.g. PROJ-123) or keyword',
      placeHolder: 'login bug…',
    });
    if (query === undefined) { return undefined; }

    const issues = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Searching Jira…' },
      () => client.searchIssues(query)
    );
    if (!issues.length) { vscode.window.showInformationMessage('No Jira issues found.'); return undefined; }

    const pick = await vscode.window.showQuickPick(
      issues.map(i => ({ label: i.key, description: i.summary, detail: i.project, issue: i })),
      { title: 'Select Jira Issue', matchOnDescription: true }
    );
    if (!pick) { return undefined; }
    return { integration: 'jira', taskId: pick.issue.id, taskKey: pick.issue.key, taskTitle: pick.issue.summary, projectName: pick.issue.project, url: pick.issue.url };
  }

  private async pickClickUpTask(): Promise<LinkedTask | undefined> {
    const client = await this.clickUpClient();
    if (!client) { return undefined; }

    let wsId = cfg().get<string>('integrations.clickup.workspaceId', '');
    if (!wsId) {
      const workspaces = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading ClickUp workspaces…' },
        () => client.getWorkspaces()
      );
      if (!workspaces.length) { vscode.window.showErrorMessage('No ClickUp workspaces found.'); return undefined; }
      if (workspaces.length === 1) {
        wsId = workspaces[0].id;
        await cfg().update('integrations.clickup.workspaceId', wsId, vscode.ConfigurationTarget.Global);
      } else {
        const sel = await vscode.window.showQuickPick(
          workspaces.map(w => ({ label: w.name, id: w.id })),
          { title: 'Select ClickUp Workspace' }
        );
        if (!sel) { return undefined; }
        wsId = sel.id;
        await cfg().update('integrations.clickup.workspaceId', wsId, vscode.ConfigurationTarget.Global);
      }
    }

    const query = await vscode.window.showInputBox({ title: 'Search ClickUp', prompt: 'Task name…' });
    if (query === undefined) { return undefined; }

    const tasks = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Searching ClickUp…' },
      () => client.searchTasks(wsId, query)
    );
    if (!tasks.length) { vscode.window.showInformationMessage('No ClickUp tasks found.'); return undefined; }

    const pick = await vscode.window.showQuickPick(
      tasks.map(t => ({ label: t.name, description: t.list?.name ?? '', detail: t.status ?? '', task: t })),
      { title: 'Select ClickUp Task', matchOnDescription: true }
    );
    if (!pick) { return undefined; }
    return { integration: 'clickup', taskId: pick.task.id, taskKey: pick.task.id, taskTitle: pick.task.name, projectName: pick.task.list?.name ?? '', url: pick.task.url };
  }

  private async pickMondayItem(): Promise<LinkedTask | undefined> {
    const client = await this.mondayClient();
    if (!client) { return undefined; }

    let boardId = cfg().get<string>('integrations.monday.boardId', '');
    if (!boardId) {
      const boards = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading Monday.com boards…' },
        () => client.getBoards()
      );
      if (!boards.length) { vscode.window.showErrorMessage('No boards found.'); return undefined; }
      const sel = await vscode.window.showQuickPick(
        boards.map(b => ({ label: b.name, id: b.id })),
        { title: 'Select Monday.com Board' }
      );
      if (!sel) { return undefined; }
      boardId = sel.id;
      await cfg().update('integrations.monday.boardId', boardId, vscode.ConfigurationTarget.Global);
    }

    const query = await vscode.window.showInputBox({ title: 'Search Monday.com', prompt: 'Item name…' });
    if (query === undefined) { return undefined; }

    const items = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Searching Monday.com…' },
      () => client.searchItems(boardId, query)
    );
    if (!items.length) { vscode.window.showInformationMessage('No items found.'); return undefined; }

    const pick = await vscode.window.showQuickPick(
      items.map(i => ({ label: i.name, item: i })),
      { title: 'Select Monday.com Item' }
    );
    if (!pick) { return undefined; }
    return { integration: 'monday', taskId: pick.item.id, taskKey: pick.item.id, taskTitle: pick.item.name, projectName: '' };
  }

  // ── Log time after session ends ───────────────────────────────────────────

  async logSessionTime(task: LinkedTask, durationMs: number, projectName: string): Promise<boolean> {
    const h = Math.floor(durationMs / 3600000);
    const m = Math.floor((durationMs % 3600000) / 60000);
    const note = `Project: ${projectName} | ${h > 0 ? `${h}h ` : ''}${m}m | Tecsxpert Timer`;
    try {
      if (task.integration === 'jira') {
        const c = await this.jiraClient();
        if (!c) { return false; }
        await c.logWork(task.taskKey, durationMs, note);
        return true;
      }
      if (task.integration === 'clickup') {
        const c = await this.clickUpClient();
        if (!c) { return false; }
        await c.logTime(task.taskId, durationMs, note);
        return true;
      }
      if (task.integration === 'monday') {
        const c = await this.mondayClient();
        if (!c) { return false; }
        await c.logTimeAsUpdate(task.taskId, durationMs, projectName);
        return true;
      }
    } catch (err) {
      console.error(`[Tecsxpert Timer] Failed to log time to ${task.integration}:`, err);
    }
    return false;
  }
}
