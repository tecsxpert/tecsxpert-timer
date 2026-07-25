import * as vscode from 'vscode';
import { TimerManager } from './TimerManager';
import { StorageManager } from './StorageManager';
import { ApiClient } from './ApiClient';
import { TimerStatus, ProjectStats, LinkedTask } from './types';

const PROJECT_COLORS = [
  '#6366f1','#0891b2','#059669','#d97706','#dc2626',
  '#7c3aed','#0284c7','#16a34a','#db2777','#ea580c',
];

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) { hash = name.charCodeAt(i) + ((hash << 5) - hash); }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}h ${String(m).padStart(2, '0')}m`
    : m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s`
    : `${sec}s`;
}

function fmtTimer(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function computeProjectStats(storage: StorageManager): ProjectStats[] {
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0,0,0,0);
  const weekStart = new Date(now - 7 * 86400000);
  const monthStart = new Date(now - 30 * 86400000);

  const map = new Map<string, ProjectStats>();
  for (const s of storage.getAllSessions()) {
    if (!map.has(s.projectName)) {
      map.set(s.projectName, {
        name: s.projectName, path: s.workspacePath,
        color: projectColor(s.projectName),
        todayMs: 0, weekMs: 0, monthMs: 0, totalMs: 0,
        sessionCount: 0, lastActive: 0,
      });
    }
    const p = map.get(s.projectName)!;
    p.totalMs += s.duration;
    p.sessionCount++;
    if (s.endTime > p.lastActive) { p.lastActive = s.endTime; }
    if (s.endTime >= dayStart.getTime())  { p.todayMs  += s.duration; }
    if (s.endTime >= weekStart.getTime()) { p.weekMs   += s.duration; }
    if (s.endTime >= monthStart.getTime()){ p.monthMs  += s.duration; }
  }
  return Array.from(map.values()).sort((a, b) => b.todayMs - a.todayMs);
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private lastStatus: TimerStatus = {
    state: 'idle', projectName: '', workspacePath: '',
    sessionStart: 0, elapsed: 0, todayTotal: 0,
  };

  constructor(
    private readonly timer: TimerManager,
    private readonly storage: StorageManager,
    private readonly ctx: vscode.ExtensionContext,
    private readonly api: ApiClient,
  ) {
    timer.on('tick', (s: TimerStatus) => { this.lastStatus = s; this.pushUpdate(s); });
    timer.on('statusChanged', (s: TimerStatus) => { this.lastStatus = s; this.pushUpdate(s); });
    timer.on('sessionSaved', () => this.pushStats());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage(msg => {
      switch (msg.type) {
        case 'start':   this.timer.start(); break;
        case 'pause':   this.timer.pause(); break;
        case 'stop':    this.timer.stop();  break;
        case 'dashboard':  vscode.commands.executeCommand('tecsxpert-timer.openDashboard'); break;
        case 'switch':     vscode.commands.executeCommand('tecsxpert-timer.switchProject'); break;
        case 'sync':       vscode.commands.executeCommand('tecsxpert-timer.syncNow'); break;
        case 'linkTask':   vscode.commands.executeCommand('tecsxpert-timer.linkTask'); break;
        case 'unlinkTask': vscode.commands.executeCommand('tecsxpert-timer.unlinkTask'); break;
        case 'setApiKey':  vscode.commands.executeCommand('tecsxpert-timer.setApiKey'); break;
        case 'ready':
          this.pushUpdate(this.lastStatus);
          this.pushStats();
          this.refreshAccount();
          break;
      }
    });
  }

  private pushUpdate(status: TimerStatus): void {
    this.view?.webview.postMessage({ type: 'status', status });
  }

  pushLinkedTask(task: LinkedTask | undefined): void {
    this.view?.webview.postMessage({ type: 'linkedTask', task });
  }

  private pushStats(): void {
    const projects = computeProjectStats(this.storage);
    const today = this.storage.getTodaySessions();
    this.view?.webview.postMessage({ type: 'stats', projects, today });
  }

  refreshAccount(): void {
    const configured = this.api.isConfigured();
    if (!configured) {
      this.view?.webview.postMessage({ type: 'account', connected: false });
      return;
    }
    this.api.getMe().then(user => {
      this.view?.webview.postMessage({ type: 'account', connected: !!user, name: user?.name, email: user?.email });
    }).catch(() => {
      this.view?.webview.postMessage({ type: 'account', connected: false });
    });
  }

  private html(): string {
    const cfg = vscode.workspace.getConfiguration('tecsxpert-timer');
    const goal = (cfg.get<number>('dailyGoalMinutes', 480)) * 60 * 1000;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --brand: #6366f1;
    --brand-dim: rgba(99,102,241,.15);
    --brand-glow: rgba(99,102,241,.35);
    --green: #22c55e;
    --yellow: #f59e0b;
    --red: #ef4444;
    --text: var(--vscode-foreground);
    --text-muted: var(--vscode-descriptionForeground);
    --bg: var(--vscode-sideBar-background);
    --bg-card: var(--vscode-editor-background);
    --border: var(--vscode-widget-border, rgba(255,255,255,.07));
    --input-bg: var(--vscode-input-background);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --radius: 10px;
  }

  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: 12px;
    color: var(--text);
    background: var(--bg);
    padding: 0;
    overflow-x: hidden;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 8px;
    border-bottom: 1px solid var(--border);
  }
  .header-brand {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--brand);
  }
  .header-brand svg { width: 16px; height: 16px; }
  .header-actions { display: flex; gap: 4px; }
  .icon-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 3px 5px;
    border-radius: 5px;
    display: flex;
    align-items: center;
    transition: color .15s, background .15s;
  }
  .icon-btn:hover { color: var(--text); background: var(--brand-dim); }
  .icon-btn svg { width: 14px; height: 14px; }

  /* ── Timer block ── */
  .timer-block {
    padding: 20px 14px 16px;
    text-align: center;
    position: relative;
  }
  .timer-ring {
    width: 130px;
    height: 130px;
    margin: 0 auto 14px;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .timer-ring svg {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    transform: rotate(-90deg);
  }
  .timer-ring-track { fill: none; stroke: var(--border); stroke-width: 3; }
  .timer-ring-fill {
    fill: none;
    stroke: var(--brand);
    stroke-width: 3;
    stroke-linecap: round;
    stroke-dasharray: 345;
    stroke-dashoffset: 345;
    transition: stroke-dashoffset 1s linear, stroke .3s;
    filter: drop-shadow(0 0 6px var(--brand-glow));
  }
  .timer-ring-fill.paused { stroke: var(--yellow); filter: drop-shadow(0 0 6px rgba(245,158,11,.4)); }
  .timer-inner {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .timer-display {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: 1px;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    line-height: 1;
    font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
  }
  .timer-display.running { color: var(--brand); }
  .timer-display.paused  { color: var(--yellow); }

  .pulse-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--brand);
    opacity: 0;
    transition: opacity .3s;
  }
  .pulse-dot.active {
    opacity: 1;
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.5); opacity: .4; }
  }

  .project-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 99px;
    font-size: 11px;
    font-weight: 600;
    background: var(--brand-dim);
    color: var(--brand);
    border: 1px solid var(--brand-glow);
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-badge.idle {
    background: var(--input-bg);
    color: var(--text-muted);
    border-color: var(--border);
  }
  .project-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ── Controls ── */
  .controls {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin-top: 14px;
  }
  .btn {
    border: none;
    cursor: pointer;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    padding: 7px 16px;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all .15s;
  }
  .btn svg { width: 13px; height: 13px; }
  .btn-primary {
    background: var(--brand);
    color: #fff;
    box-shadow: 0 2px 8px var(--brand-glow);
  }
  .btn-primary:hover { filter: brightness(1.15); transform: translateY(-1px); }
  .btn-secondary {
    background: var(--input-bg);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover { border-color: var(--brand); color: var(--brand); }
  .btn-danger {
    background: rgba(239,68,68,.12);
    color: var(--red);
    border: 1px solid rgba(239,68,68,.25);
  }
  .btn-danger:hover { background: rgba(239,68,68,.22); }
  .btn:disabled { opacity: .35; cursor: not-allowed; transform: none !important; }

  /* ── Today stats row ── */
  .stats-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px;
    padding: 0 12px 12px;
  }
  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    text-align: center;
  }
  .stat-value {
    font-size: 14px;
    font-weight: 800;
    color: var(--text);
    line-height: 1;
    margin-bottom: 3px;
  }
  .stat-value.brand { color: var(--brand); }
  .stat-label {
    font-size: 9.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .4px;
    color: var(--text-muted);
  }

  /* ── Goal bar ── */
  .goal-section {
    padding: 0 12px 14px;
  }
  .goal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
    font-size: 10px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .4px;
  }
  .goal-pct { color: var(--brand); font-weight: 700; }
  .goal-track {
    height: 5px;
    background: var(--input-bg);
    border-radius: 99px;
    overflow: hidden;
  }
  .goal-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--brand), #8b5cf6);
    border-radius: 99px;
    transition: width .8s ease;
  }
  .goal-fill.done { background: linear-gradient(90deg, var(--green), #16a34a); }

  /* ── Section header ── */
  .section {
    padding: 0 12px;
    margin-bottom: 8px;
  }
  .section-title {
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .6px;
    color: var(--text-muted);
    padding: 8px 0 6px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  /* ── Project bars ── */
  .project-list { display: flex; flex-direction: column; gap: 6px; }
  .project-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .project-row-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .project-name {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 140px;
  }
  .project-color-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .project-time {
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .bar-track {
    height: 3px;
    background: var(--input-bg);
    border-radius: 99px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    border-radius: 99px;
    transition: width .6s ease;
    opacity: .85;
  }

  /* ── Session list ── */
  .session-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .session-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--bg-card);
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  .session-color { width: 3px; height: 28px; border-radius: 99px; flex-shrink: 0; }
  .session-info { flex: 1; min-width: 0; }
  .session-project { font-size: 11.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .account-card {
    margin: 0 12px 10px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 9px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .account-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    background: var(--red);
  }
  .account-dot.connected { background: var(--green); }
  .account-info { flex: 1; min-width: 0; }
  .account-name { font-size: 11.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .account-email { font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .account-action { font-size: 10px; color: var(--brand); cursor: pointer; text-decoration: none; white-space: nowrap; flex-shrink: 0; background: none; border: none; padding: 0; }
  .account-action:hover { text-decoration: underline; }
  .session-time { font-size: 10.5px; color: var(--text-muted); margin-top: 1px; }
  .session-duration {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  /* ── Linked task ── */
  .linked-task-row {
    display: none;
    padding: 0 12px 10px;
  }
  .linked-task-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px 5px 8px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-card);
    font-size: 11px;
    cursor: default;
  }
  .linked-task-badge {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 2px 5px;
    border-radius: 4px;
    letter-spacing: .4px;
    flex-shrink: 0;
  }
  .linked-task-badge.jira    { background: #0052cc22; color: #0052cc; }
  .linked-task-badge.clickup { background: #7b68ee22; color: #7b68ee; }
  .linked-task-badge.monday  { background: #ff3d5722; color: #ff3d57; }
  .linked-task-key   { font-weight: 700; color: var(--text); flex-shrink: 0; }
  .linked-task-title { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .linked-task-unlink {
    background: none; border: none; cursor: pointer;
    color: var(--text-muted); padding: 0 0 0 2px; font-size: 13px; line-height: 1;
    flex-shrink: 0;
  }
  .linked-task-unlink:hover { color: var(--red); }

  /* ── Empty state ── */
  .empty {
    text-align: center;
    color: var(--text-muted);
    padding: 16px 0;
    font-size: 11px;
    font-style: italic;
  }

  /* ── Footer ── */
  .footer {
    padding: 10px 12px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 6px;
  }
  .footer .btn { flex: 1; justify-content: center; font-size: 11px; padding: 6px 0; }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-brand">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
    Tecsxpert Timer
  </div>
  <div class="header-actions">
    <button class="icon-btn" title="Switch project" onclick="post('switch')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
    </button>
    <button class="icon-btn" title="Open dashboard" onclick="post('dashboard')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
    </button>
    <button class="icon-btn" title="Sync now" onclick="post('sync')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.81"/></svg>
    </button>
  </div>
</div>

<!-- Timer Ring -->
<div class="timer-block">
  <div class="timer-ring">
    <svg viewBox="0 0 120 120">
      <circle class="timer-ring-track" cx="60" cy="60" r="55"/>
      <circle class="timer-ring-fill" id="ringFill" cx="60" cy="60" r="55"/>
    </svg>
    <div class="timer-inner">
      <div class="pulse-dot" id="pulseDot"></div>
      <div class="timer-display" id="timerDisplay">00:00:00</div>
    </div>
  </div>
  <div class="project-badge idle" id="projectBadge">
    <div class="project-dot"></div>
    <span id="projectName">No project</span>
  </div>
</div>

<!-- Linked Task -->
<div class="linked-task-row" id="linkedTaskRow">
  <div class="linked-task-chip">
    <span class="linked-task-badge" id="linkedTaskBadge">—</span>
    <span class="linked-task-key" id="linkedTaskKey"></span>
    <span class="linked-task-title" id="linkedTaskTitle"></span>
    <button class="linked-task-unlink" title="Unlink task" onclick="post('unlinkTask')">✕</button>
  </div>
</div>

<!-- Controls -->
<div class="controls" id="controls">
  <button class="btn btn-primary" id="btnStart" onclick="post('start')">
    <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    Start
  </button>
  <button class="btn btn-secondary" id="btnPause" onclick="post('pause')" disabled>
    <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
    Pause
  </button>
  <button class="btn btn-danger" id="btnStop" onclick="post('stop')" disabled>
    <svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
    Stop
  </button>
</div>

<!-- Today stats -->
<div class="stats-row" style="margin-top:14px">
  <div class="stat-card">
    <div class="stat-value brand" id="statToday">0m</div>
    <div class="stat-label">Today</div>
  </div>
  <div class="stat-card">
    <div class="stat-value" id="statSessions">0</div>
    <div class="stat-label">Sessions</div>
  </div>
  <div class="stat-card">
    <div class="stat-value" id="statGoalPct">0%</div>
    <div class="stat-label">Goal</div>
  </div>
</div>

<!-- Goal bar -->
<div class="goal-section">
  <div class="goal-header">
    <span>Daily goal</span>
    <span class="goal-pct" id="goalPctLabel">0%</span>
  </div>
  <div class="goal-track">
    <div class="goal-fill" id="goalFill" style="width:0%"></div>
  </div>
</div>

<!-- Projects -->
<div class="section">
  <div class="section-title">
    <span>Today's Projects</span>
  </div>
  <div class="project-list" id="projectList">
    <div class="empty">No sessions yet today</div>
  </div>
</div>

<!-- Recent Sessions -->
<div class="section">
  <div class="section-title"><span>Recent Sessions</span></div>
  <div class="session-list" id="sessionList">
    <div class="empty">No sessions yet today</div>
  </div>
</div>

<!-- Account -->
<div class="account-card" id="accountCard">
  <div class="account-dot" id="accountDot"></div>
  <div class="account-info">
    <div class="account-name" id="accountName">Not connected</div>
    <div class="account-email" id="accountEmail">Set your API key to connect</div>
  </div>
  <button class="account-action" id="accountAction" onclick="post('setApiKey')">Set Key</button>
</div>

<!-- Footer -->
<div class="footer">
  <button class="btn btn-secondary" onclick="post('dashboard')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
    Dashboard
  </button>
  <button class="btn btn-secondary" title="Link to Jira / ClickUp / Monday.com" onclick="post('linkTask')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
    Link Task
  </button>
  <button class="btn btn-secondary" onclick="post('sync')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.81"/></svg>
    Sync
  </button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const GOAL_MS = ${goal};

  function post(type, data = {}) { vscode.postMessage({ type, ...data }); }

  function fmtTimer(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h,m,sec].map(n => String(n).padStart(2,'0')).join(':');
  }

  function fmtMs(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + 'h ' + String(m).padStart(2,'0') + 'm';
    if (m > 0) return m + 'm ' + String(s % 60).padStart(2,'0') + 's';
    return s + 's';
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const PROJECT_COLORS = ['#6366f1','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#0284c7','#16a34a','#db2777','#ea580c'];
  function projectColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
  }

  function applyStatus(status) {
    const { state, elapsed, todayTotal, projectName } = status;

    // Timer display
    const disp = document.getElementById('timerDisplay');
    disp.textContent = fmtTimer(elapsed);
    disp.className = 'timer-display ' + (state === 'running' ? 'running' : state === 'paused' ? 'paused' : '');

    // Pulse dot
    const dot = document.getElementById('pulseDot');
    dot.className = 'pulse-dot' + (state === 'running' ? ' active' : '');

    // Ring
    const fill = document.getElementById('ringFill');
    const circumference = 345;
    const pct = Math.min(1, todayTotal / GOAL_MS);
    fill.style.strokeDashoffset = circumference - (circumference * pct);
    fill.className = 'timer-ring-fill' + (state === 'paused' ? ' paused' : '');

    // Project badge
    const badge = document.getElementById('projectBadge');
    const nameEl = document.getElementById('projectName');
    nameEl.textContent = projectName || 'No project';
    if (state !== 'idle' && projectName) {
      badge.className = 'project-badge';
      badge.style.color = projectColor(projectName);
      badge.style.background = projectColor(projectName) + '22';
      badge.style.borderColor = projectColor(projectName) + '55';
    } else {
      badge.className = 'project-badge idle';
      badge.style.color = ''; badge.style.background = ''; badge.style.borderColor = '';
    }

    // Buttons
    document.getElementById('btnStart').disabled = state === 'running';
    document.getElementById('btnPause').disabled = state !== 'running';
    document.getElementById('btnStop').disabled  = state === 'idle';

    // Stats
    const goalPct = Math.min(100, Math.round((todayTotal / GOAL_MS) * 100));
    document.getElementById('statToday').textContent   = fmtMs(todayTotal);
    document.getElementById('statGoalPct').textContent = goalPct + '%';
    document.getElementById('goalPctLabel').textContent = goalPct + '%';
    const goalFill = document.getElementById('goalFill');
    goalFill.style.width = goalPct + '%';
    goalFill.className = 'goal-fill' + (goalPct >= 100 ? ' done' : '');
  }

  function applyStats(projects, today) {
    // Session count
    document.getElementById('statSessions').textContent = today.length;

    // Project bars
    const pl = document.getElementById('projectList');
    if (!projects.length || projects.every(p => p.todayMs === 0)) {
      pl.innerHTML = '<div class="empty">No sessions yet today</div>';
    } else {
      const maxMs = Math.max(...projects.filter(p => p.todayMs > 0).map(p => p.todayMs));
      pl.innerHTML = projects.filter(p => p.todayMs > 0).map(p => {
        const pct = Math.round((p.todayMs / maxMs) * 100);
        const color = projectColor(p.name);
        return \`<div class="project-row">
          <div class="project-row-header">
            <div class="project-name">
              <div class="project-color-dot" style="background:\${color}"></div>
              \${p.name}
            </div>
            <div class="project-time">\${fmtMs(p.todayMs)}</div>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:\${pct}%;background:\${color}"></div></div>
        </div>\`;
      }).join('');
    }

    // Session list (most recent first)
    const sl = document.getElementById('sessionList');
    const sorted = [...today].sort((a,b) => b.endTime - a.endTime).slice(0, 8);
    if (!sorted.length) {
      sl.innerHTML = '<div class="empty">No sessions yet today</div>';
    } else {
      sl.innerHTML = sorted.map(s => {
        const color = projectColor(s.projectName);
        return \`<div class="session-item">
          <div class="session-color" style="background:\${color}"></div>
          <div class="session-info">
            <div class="session-project">\${s.projectName}</div>
            <div class="session-time">\${fmtTime(s.startTime)} – \${fmtTime(s.endTime)}</div>
          </div>
          <div class="session-duration">\${fmtMs(s.duration)}</div>
        </div>\`;
      }).join('');
    }
  }

  function applyLinkedTask(task) {
    const row = document.getElementById('linkedTaskRow');
    if (!task) { row.style.display = 'none'; return; }
    row.style.display = 'block';
    const badge = document.getElementById('linkedTaskBadge');
    badge.textContent = task.integration.toUpperCase();
    badge.className = 'linked-task-badge ' + task.integration;
    const isJira = task.integration === 'jira';
    document.getElementById('linkedTaskKey').textContent   = isJira ? task.taskKey : '';
    document.getElementById('linkedTaskTitle').textContent = task.taskTitle;
  }

  function applyAccount(msg) {
    const dot    = document.getElementById('accountDot');
    const name   = document.getElementById('accountName');
    const email  = document.getElementById('accountEmail');
    const action = document.getElementById('accountAction');
    if (msg.connected) {
      dot.className = 'account-dot connected';
      name.textContent  = msg.name  || 'Connected';
      email.textContent = msg.email || 'Tecsxpert GRC';
      action.textContent = 'Change';
    } else {
      dot.className = 'account-dot';
      name.textContent  = 'Not connected';
      email.textContent = 'Set your API key to connect';
      action.textContent = 'Set Key';
    }
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'status')     { applyStatus(msg.status); }
    if (msg.type === 'stats')      { applyStats(msg.projects, msg.today); }
    if (msg.type === 'linkedTask') { applyLinkedTask(msg.task); }
    if (msg.type === 'account')    { applyAccount(msg); }
  });

  post('ready');
</script>
</body>
</html>`;
  }
}
