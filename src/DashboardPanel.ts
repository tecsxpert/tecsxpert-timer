import * as vscode from 'vscode';
import { StorageManager } from './StorageManager';
import { TimerManager } from './TimerManager';
import { ApiClient } from './ApiClient';
import { Session, ProjectStats, DailyTotal } from './types';

const PROJECT_COLORS = [
  '#6366f1','#0891b2','#059669','#d97706','#dc2626',
  '#7c3aed','#0284c7','#16a34a','#db2777','#ea580c',
];

function projectColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) { h = name.charCodeAt(i) + ((h << 5) - h); }
  return PROJECT_COLORS[Math.abs(h) % PROJECT_COLORS.length];
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : m > 0 ? `${m}m` : `${s}s`;
}

function dateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function buildStats(storage: StorageManager) {
  const now = Date.now();
  const dayStart   = new Date(); dayStart.setHours(0,0,0,0);
  const weekStart  = new Date(now - 7  * 86400000);
  const monthStart = new Date(now - 30 * 86400000);

  const all = storage.getAllSessions();
  const projectMap = new Map<string, ProjectStats>();
  const dailyMap   = new Map<string, number>();

  for (const s of all) {
    if (!projectMap.has(s.projectName)) {
      projectMap.set(s.projectName, {
        name: s.projectName, path: s.workspacePath, color: projectColor(s.projectName),
        todayMs: 0, weekMs: 0, monthMs: 0, totalMs: 0, sessionCount: 0, lastActive: 0,
      });
    }
    const p = projectMap.get(s.projectName)!;
    p.totalMs += s.duration; p.sessionCount++;
    if (s.endTime > p.lastActive) { p.lastActive = s.endTime; }
    if (s.endTime >= dayStart.getTime())   { p.todayMs  += s.duration; }
    if (s.endTime >= weekStart.getTime())  { p.weekMs   += s.duration; }
    if (s.endTime >= monthStart.getTime()) { p.monthMs  += s.duration; }

    const dk = dateKey(s.startTime);
    dailyMap.set(dk, (dailyMap.get(dk) || 0) + s.duration);
  }

  // Build 14-day array
  const daily: DailyTotal[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const k = d.toISOString().slice(0, 10);
    daily.push({ date: k, totalMs: dailyMap.get(k) || 0 });
  }

  const projects = Array.from(projectMap.values()).sort((a, b) => b.todayMs - a.todayMs);
  const totalToday = projects.reduce((s, p) => s + p.todayMs, 0);
  const totalWeek  = projects.reduce((s, p) => s + p.weekMs,  0);
  const totalMonth = projects.reduce((s, p) => s + p.monthMs, 0);
  const totalSessions = all.length;

  // Streak
  let streak = 0;
  let checkDate = new Date(); checkDate.setHours(0,0,0,0);
  while (true) {
    const k = checkDate.toISOString().slice(0, 10);
    if ((dailyMap.get(k) || 0) > 0) {
      streak++;
      checkDate = new Date(checkDate.getTime() - 86400000);
    } else { break; }
  }

  return { projects, daily, totalToday, totalWeek, totalMonth, totalSessions, streak };
}

export class DashboardPanel {
  private static instance?: DashboardPanel;
  private panel: vscode.WebviewPanel;

  static show(
    ctx: vscode.ExtensionContext,
    storage: StorageManager,
    timer: TimerManager,
    api: ApiClient,
  ): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal();
      DashboardPanel.instance.refresh(storage, timer, api);
      return;
    }
    DashboardPanel.instance = new DashboardPanel(ctx, storage, timer, api);
  }

  private constructor(
    private ctx: vscode.ExtensionContext,
    private storage: StorageManager,
    private timer: TimerManager,
    private api: ApiClient,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'tecsxpert-timer.dashboard',
      'Tecsxpert Timer — Dashboard',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'resources', 'activity-icon.svg');
    this.panel.onDidDispose(() => { DashboardPanel.instance = undefined; });
    this.panel.webview.html = this.html(storage, timer);

    // Refresh when timer ticks
    this.timer.on('tick', () => this.pushStats(storage, timer));
    this.timer.on('statusChanged', () => this.pushStats(storage, timer));
    this.timer.on('sessionSaved', () => this.pushStats(storage, timer));

    this.panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready':     this.pushStats(storage, timer); break;
        case 'start':     this.timer.start(); break;
        case 'pause':     this.timer.pause(); break;
        case 'stop':      this.timer.stop();  break;
        case 'syncNow':   await this.doSync(api, storage); break;
        case 'setApiKey': {
          const key = msg.key?.trim();
          if (key) {
            await this.ctx.workspaceState.update('apiKey', key);
            await vscode.workspace.getConfiguration('tecsxpert-timer').update('apiKey', key, true);
            const ok = await api.testConnection();
            this.panel.webview.postMessage({ type: 'syncStatus', ok, message: ok ? 'Connected!' : 'Connection failed — check your API key.' });
          }
          break;
        }
        case 'testConnection': {
          const ok = await api.testConnection();
          this.panel.webview.postMessage({ type: 'syncStatus', ok, message: ok ? 'Connection successful!' : 'Cannot reach Tecsxpert API — check key and network.' });
          break;
        }
      }
    });
  }

  private pushStats(storage: StorageManager, timer: TimerManager): void {
    const stats  = buildStats(storage);
    const status = timer.getStatus();
    const cfg    = vscode.workspace.getConfiguration('tecsxpert-timer');
    this.panel.webview.postMessage({
      type: 'update',
      ...stats,
      status,
      goalMs:           (cfg.get<number>('dailyGoalMinutes', 480)) * 60 * 1000,
      isApiConfigured:  this.api.isConfigured(),
      lastSync:         storage.getLastSync(),
      unsyncedCount:    storage.getUnsynced().length,
    });
  }

  private async doSync(api: ApiClient, storage: StorageManager): Promise<void> {
    this.panel.webview.postMessage({ type: 'syncStatus', syncing: true, message: 'Syncing…' });
    try {
      const unsynced = storage.getUnsynced();
      if (!unsynced.length) {
        this.panel.webview.postMessage({ type: 'syncStatus', ok: true, message: 'Nothing to sync — all sessions up to date.' });
        return;
      }
      const synced = await api.syncSessions(unsynced);
      storage.markSynced(synced);
      this.panel.webview.postMessage({ type: 'syncStatus', ok: true, message: `Synced ${synced.length} session${synced.length !== 1 ? 's' : ''} successfully.` });
    } catch (e: any) {
      this.panel.webview.postMessage({ type: 'syncStatus', ok: false, message: `Sync failed: ${e.message}` });
    }
  }

  private refresh(storage: StorageManager, timer: TimerManager, api: ApiClient): void {
    this.storage = storage; this.timer = timer; this.api = api;
    this.pushStats(storage, timer);
  }

  private html(storage: StorageManager, timer: TimerManager): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Tecsxpert Timer Dashboard</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --brand: #6366f1;
  --brand-dim: rgba(99,102,241,.12);
  --brand-glow: rgba(99,102,241,.3);
  --green: #22c55e;
  --yellow: #f59e0b;
  --red: #ef4444;
  --text: var(--vscode-foreground);
  --text-muted: var(--vscode-descriptionForeground);
  --bg: var(--vscode-editor-background);
  --bg-card: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  --bg-hover: var(--vscode-list-hoverBackground);
  --border: var(--vscode-widget-border, rgba(255,255,255,.08));
  --input-bg: var(--vscode-input-background);
  --input-border: var(--vscode-input-border, var(--border));
  --radius: 12px;
  --shadow: 0 2px 12px rgba(0,0,0,.15);
}

body {
  font-family: var(--vscode-font-family, -apple-system, sans-serif);
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
  padding: 0;
  overflow-x: hidden;
}

/* ── Layout ── */
.container { max-width: 1100px; margin: 0 auto; padding: 28px 24px 60px; }

/* ── Header ── */
.dash-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 28px;
  gap: 16px;
}
.dash-title h1 {
  font-size: 22px;
  font-weight: 800;
  color: var(--text);
  letter-spacing: -.4px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.dash-title h1 .brand-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: var(--brand);
  display: inline-block;
  box-shadow: 0 0 8px var(--brand-glow);
}
.dash-subtitle { font-size: 12.5px; color: var(--text-muted); margin-top: 4px; }

.header-controls { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }

/* ── Buttons ── */
.btn {
  border: none;
  cursor: pointer;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  padding: 8px 16px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all .15s;
  font-family: inherit;
}
.btn svg { width: 13px; height: 13px; flex-shrink: 0; }
.btn-primary { background: var(--brand); color: #fff; box-shadow: 0 2px 8px var(--brand-glow); }
.btn-primary:hover { filter: brightness(1.15); transform: translateY(-1px); box-shadow: 0 4px 14px var(--brand-glow); }
.btn-secondary { background: var(--input-bg); color: var(--text); border: 1px solid var(--border); }
.btn-secondary:hover { border-color: var(--brand); color: var(--brand); }
.btn-ghost { background: none; color: var(--text-muted); border: 1px solid var(--border); }
.btn-ghost:hover { color: var(--text); border-color: var(--text-muted); }
.btn:disabled { opacity: .4; cursor: not-allowed; transform: none !important; }
.btn-sm { padding: 5px 11px; font-size: 11.5px; }

/* ── Stat cards row ── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}
.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
  position: relative;
  overflow: hidden;
}
.stat-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: var(--stat-color, var(--brand));
  border-radius: var(--radius) var(--radius) 0 0;
}
.stat-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .5px;
  color: var(--text-muted);
  margin-bottom: 8px;
}
.stat-value {
  font-size: 22px;
  font-weight: 800;
  color: var(--text);
  line-height: 1;
  letter-spacing: -.5px;
  font-variant-numeric: tabular-nums;
}
.stat-sub { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

/* ── Grid layout ── */
.main-grid {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 16px;
  margin-bottom: 16px;
}
.full-width { grid-column: 1 / -1; }

/* ── Cards ── */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  box-shadow: var(--shadow);
}
.card-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .5px;
  color: var(--text-muted);
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* ── Active timer card ── */
.timer-card {
  background: linear-gradient(135deg, var(--brand-dim) 0%, transparent 100%);
  border-color: var(--brand-glow);
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 16px 20px;
}
.timer-ring-sm {
  width: 72px; height: 72px;
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.timer-ring-sm svg { position: absolute; top:0;left:0;width:100%;height:100%; transform:rotate(-90deg); }
.timer-ring-sm .track { fill:none; stroke:var(--border); stroke-width:4; }
.timer-ring-sm .fill  { fill:none; stroke:var(--brand); stroke-width:4; stroke-linecap:round; stroke-dasharray:204; stroke-dashoffset:204; transition: stroke-dashoffset 1s linear; filter:drop-shadow(0 0 4px var(--brand-glow)); }
.timer-ring-sm .fill.paused { stroke: var(--yellow); }
.timer-num {
  position: relative;
  font-size: 14px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--brand);
  font-family: 'JetBrains Mono','Courier New',monospace;
  letter-spacing: .5px;
}
.timer-info { flex: 1; }
.timer-info h2 { font-size: 16px; font-weight: 700; color: var(--text); margin-bottom: 4px; }
.timer-info p  { font-size: 12px; color: var(--text-muted); margin-bottom: 10px; }
.timer-controls { display: flex; gap: 6px; }

/* ── Bar chart ── */
.chart-wrap { position: relative; }
.bar-chart {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 110px;
  padding-bottom: 24px;
}
.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  gap: 4px;
  position: relative;
}
.bar-col:hover .bar-rect { opacity: 1; filter: brightness(1.2); }
.bar-col:hover .bar-tooltip { display: block; }
.bar-rect {
  width: 100%;
  min-height: 2px;
  border-radius: 4px 4px 0 0;
  background: var(--brand);
  opacity: .6;
  transition: all .3s;
  cursor: default;
}
.bar-rect.today { opacity: 1; box-shadow: 0 0 8px var(--brand-glow); }
.bar-label {
  font-size: 9px;
  color: var(--text-muted);
  position: absolute;
  bottom: 0;
  text-align: center;
  width: 100%;
  white-space: nowrap;
}
.bar-tooltip {
  display: none;
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--vscode-editorHoverWidget-background, #1e293b);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text);
  white-space: nowrap;
  z-index: 10;
  pointer-events: none;
}
.chart-y-labels {
  position: absolute;
  top: 0; left: -4px;
  height: calc(100% - 24px);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  font-size: 9px;
  color: var(--text-muted);
}

/* ── Donut chart ── */
.donut-wrap {
  display: flex;
  align-items: center;
  gap: 16px;
}
.donut-svg { flex-shrink: 0; }
.donut-legend { flex: 1; display: flex; flex-direction: column; gap: 7px; }
.donut-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.donut-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.donut-name { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.donut-pct  { font-size: 11px; color: var(--text-muted); font-weight: 600; flex-shrink: 0; }

/* ── Session table ── */
.session-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.session-table th {
  text-align: left;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .4px;
  color: var(--text-muted);
  padding: 0 12px 10px;
  border-bottom: 1px solid var(--border);
}
.session-table td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  vertical-align: middle;
}
.session-table tr:last-child td { border-bottom: none; }
.session-table tr:hover td { background: var(--bg-hover); }
.proj-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 99px;
  font-size: 11px;
  font-weight: 600;
}
.sync-badge {
  font-size: 9.5px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: .2px;
}
.sync-yes { background: rgba(34,197,94,.12); color: var(--green); }
.sync-no  { background: rgba(239,68,68,.10); color: var(--red); }

/* ── Settings ── */
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-group { display: flex; flex-direction: column; gap: 6px; }
.form-label { font-size: 11.5px; font-weight: 600; color: var(--text); }
.form-hint  { font-size: 10.5px; color: var(--text-muted); margin-top: -2px; }
.form-row   { display: flex; gap: 8px; }
.form-input {
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 7px;
  color: var(--text);
  font-size: 12.5px;
  font-family: inherit;
  padding: 7px 10px;
  width: 100%;
  outline: none;
  transition: border-color .15s;
}
.form-input:focus { border-color: var(--brand); }
.form-input[type=password] { font-family: monospace; letter-spacing: 2px; }

/* ── Status toast ── */
.toast {
  display: none;
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 500;
  align-items: center;
  gap: 8px;
}
.toast.show  { display: flex; }
.toast.ok    { background: rgba(34,197,94,.1); border:1px solid rgba(34,197,94,.3); color: var(--green); }
.toast.error { background: rgba(239,68,68,.1); border:1px solid rgba(239,68,68,.3); color: var(--red); }
.toast.info  { background: var(--brand-dim); border:1px solid var(--brand-glow); color: var(--brand); }

/* ── Goal progress ── */
.goal-bar-wrap { margin-top: 10px; }
.goal-bar-header { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-bottom: 6px; }
.goal-bar-track { height: 6px; background: var(--input-bg); border-radius: 99px; overflow: hidden; }
.goal-bar-fill  { height: 100%; background: linear-gradient(90deg, var(--brand), #8b5cf6); border-radius: 99px; transition: width .8s ease; }
.goal-bar-fill.done { background: linear-gradient(90deg, var(--green), #16a34a); }

/* ── Streak ── */
.streak-flame { font-size: 18px; }
</style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="dash-header">
    <div class="dash-title">
      <h1>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Tecsxpert Timer
        <span class="brand-dot"></span>
      </h1>
      <div class="dash-subtitle" id="dashSubtitle">Loading…</div>
    </div>
    <div class="header-controls">
      <button class="btn btn-ghost btn-sm" id="hdrPause" onclick="post('pause')" disabled>
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        Pause
      </button>
      <button class="btn btn-primary btn-sm" id="hdrStart" onclick="post('start')">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Start
      </button>
      <button class="btn btn-ghost btn-sm" onclick="post('syncNow')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.81"/></svg>
        Sync
      </button>
    </div>
  </div>

  <!-- Stats row -->
  <div class="stats-grid">
    <div class="stat-card" style="--stat-color:#6366f1">
      <div class="stat-label">Today</div>
      <div class="stat-value" id="sToday">—</div>
      <div class="stat-sub" id="sTodaySub"></div>
    </div>
    <div class="stat-card" style="--stat-color:#0891b2">
      <div class="stat-label">This Week</div>
      <div class="stat-value" id="sWeek">—</div>
    </div>
    <div class="stat-card" style="--stat-color:#059669">
      <div class="stat-label">This Month</div>
      <div class="stat-value" id="sMonth">—</div>
    </div>
    <div class="stat-card" style="--stat-color:#d97706">
      <div class="stat-label">Total Sessions</div>
      <div class="stat-value" id="sSessions">—</div>
    </div>
    <div class="stat-card" style="--stat-color:#dc2626">
      <div class="stat-label">Streak</div>
      <div class="stat-value"><span class="streak-flame">🔥</span> <span id="sStreak">0</span></div>
      <div class="stat-sub">days in a row</div>
    </div>
  </div>

  <!-- Active timer + bar chart -->
  <div class="main-grid">

    <!-- Left: bar chart -->
    <div class="card">
      <div class="card-title">
        <span>14-Day Activity</span>
        <span id="avgLabel" style="font-weight:400"></span>
      </div>
      <div class="chart-wrap" style="padding-left: 28px; position:relative">
        <div class="chart-y-labels" id="yLabels"></div>
        <div class="bar-chart" id="barChart"></div>
      </div>
    </div>

    <!-- Right: current timer + donut -->
    <div style="display:flex;flex-direction:column;gap:12px">

      <!-- Timer card -->
      <div class="card timer-card">
        <div class="timer-ring-sm">
          <svg viewBox="0 0 72 72">
            <circle class="track" cx="36" cy="36" r="32"/>
            <circle class="fill" id="dRingFill" cx="36" cy="36" r="32"/>
          </svg>
          <div class="timer-num" id="dTimerNum">00:00:00</div>
        </div>
        <div class="timer-info">
          <h2 id="dProject">Idle</h2>
          <p id="dProjectPath"></p>
          <div class="timer-controls">
            <button class="btn btn-primary btn-sm" id="dStart" onclick="post('start')">
              <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start
            </button>
            <button class="btn btn-secondary btn-sm" id="dPause" onclick="post('pause')" disabled>
              <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause
            </button>
            <button class="btn btn-ghost btn-sm" id="dStop" onclick="post('stop')" disabled>
              <svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Project donut -->
      <div class="card" style="flex:1">
        <div class="card-title"><span>Projects (30 days)</span></div>
        <div class="donut-wrap">
          <svg class="donut-svg" width="100" height="100" viewBox="0 0 100 100" id="donutSvg">
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--border)" stroke-width="12"/>
          </svg>
          <div class="donut-legend" id="donutLegend"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Daily goal -->
  <div class="card" style="margin-bottom:16px">
    <div class="card-title"><span>Daily Goal Progress</span><span id="goalLabel"></span></div>
    <div class="goal-bar-wrap">
      <div class="goal-bar-header">
        <span id="goalLeft"></span>
        <span id="goalPct" style="color:var(--brand);font-weight:700"></span>
      </div>
      <div class="goal-bar-track"><div class="goal-bar-fill" id="goalBarFill" style="width:0%"></div></div>
    </div>
  </div>

  <!-- Session log -->
  <div class="card" style="margin-bottom:16px">
    <div class="card-title"><span>Recent Sessions</span><span id="sessionCount" style="font-weight:400"></span></div>
    <table class="session-table">
      <thead>
        <tr>
          <th>Project</th>
          <th>Date</th>
          <th>Start</th>
          <th>End</th>
          <th>Duration</th>
          <th>Synced</th>
        </tr>
      </thead>
      <tbody id="sessionTableBody">
        <tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px">No sessions yet</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Settings -->
  <div class="card">
    <div class="card-title"><span>Settings & API Connection</span></div>
    <div class="settings-grid">
      <div class="form-group" style="grid-column:1/-1">
        <div class="form-label">Tecsxpert API Key</div>
        <div class="form-hint">Get your key from <strong>app.tecsxpert.com → Settings → API Keys</strong></div>
        <div class="form-row" style="margin-top:6px">
          <input type="password" class="form-input" id="apiKeyInput" placeholder="paste your API key here…" oninput="onApiKeyChange()">
          <button class="btn btn-secondary btn-sm" onclick="saveApiKey()" style="flex-shrink:0">Save</button>
          <button class="btn btn-ghost btn-sm" onclick="post('testConnection')" style="flex-shrink:0">Test</button>
        </div>
      </div>
      <div class="form-group">
        <div class="form-label">Idle timeout (minutes)</div>
        <div class="form-hint">Pause after this many minutes of inactivity (0 = never)</div>
        <input type="number" class="form-input" id="idleInput" min="0" max="120" value="5" style="margin-top:6px" oninput="saveSetting('idleThresholdMinutes', parseInt(this.value))">
      </div>
      <div class="form-group">
        <div class="form-label">Daily goal (minutes)</div>
        <div class="form-hint">Sets the progress ring and goal bar target</div>
        <input type="number" class="form-input" id="goalInput" min="30" max="1440" value="480" style="margin-top:6px" oninput="saveSetting('dailyGoalMinutes', parseInt(this.value))">
      </div>
    </div>
    <div class="toast" id="toast"></div>
  </div>

</div><!-- /container -->

<script>
  const vscode = acquireVsCodeApi();
  let GOAL_MS = 480 * 60 * 1000;

  const PROJECT_COLORS = ['#6366f1','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#0284c7','#16a34a','#db2777','#ea580c'];
  function projectColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h<<5)-h);
    return PROJECT_COLORS[Math.abs(h) % PROJECT_COLORS.length];
  }

  function post(type, data={}) { vscode.postMessage({type,...data}); }

  function fmtMs(ms) {
    const s = Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
    return h>0 ? h+'h '+String(m).padStart(2,'0')+'m' : m>0 ? m+'m' : s+'s';
  }
  function fmtTimer(ms) {
    const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
    return [h,m,sec].map(n=>String(n).padStart(2,'0')).join(':');
  }
  function fmtTime(ts) { return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
  function fmtDate(ts) { return new Date(ts).toLocaleDateString([],{month:'short',day:'numeric'}); }

  function applyStatus(status) {
    const {state,elapsed,todayTotal,projectName,workspacePath} = status;
    const running = state==='running', paused=state==='paused';

    // Header
    const now = new Date();
    document.getElementById('dashSubtitle').textContent =
      running ? \`Timer running · \${projectName}\` :
      paused  ? \`Timer paused  · \${projectName}\` :
                \`\${now.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}\`;

    // Header buttons
    document.getElementById('hdrStart').disabled = running;
    document.getElementById('hdrPause').disabled = !running;

    // Timer card
    document.getElementById('dTimerNum').textContent = fmtTimer(elapsed);
    document.getElementById('dTimerNum').style.color = running ? 'var(--brand)' : paused ? 'var(--yellow)' : 'var(--text-muted)';
    document.getElementById('dProject').textContent = projectName || 'No active project';
    document.getElementById('dProjectPath').textContent = workspacePath ? workspacePath.split('/').slice(-2).join('/') : '';
    document.getElementById('dStart').disabled = running;
    document.getElementById('dPause').disabled = !running;
    document.getElementById('dStop').disabled  = state==='idle';

    // Ring
    const fill = document.getElementById('dRingFill');
    const pct = Math.min(1, todayTotal / GOAL_MS);
    fill.style.strokeDashoffset = 204 - (204 * pct);
    fill.className = 'fill' + (paused ? ' paused' : '');

    // Goal bar
    const goalPct = Math.min(100, Math.round((todayTotal / GOAL_MS) * 100));
    document.getElementById('sTodaySub').textContent = running ? '● recording' : '';
    document.getElementById('goalPct').textContent = goalPct + '%';
    const remaining = Math.max(0, GOAL_MS - todayTotal);
    document.getElementById('goalLeft').textContent = goalPct >= 100 ? '🎉 Daily goal reached!' : fmtMs(remaining) + ' remaining';
    const gf = document.getElementById('goalBarFill');
    gf.style.width = goalPct + '%';
    gf.className = 'goal-bar-fill' + (goalPct >= 100 ? ' done' : '');
  }

  function applyUpdate(data) {
    const {projects, daily, totalToday, totalWeek, totalMonth, totalSessions, streak, status, goalMs, lastSync, unsyncedCount} = data;
    GOAL_MS = goalMs;

    applyStatus(status);

    // Stats
    document.getElementById('sToday').textContent  = fmtMs(totalToday);
    document.getElementById('sWeek').textContent   = fmtMs(totalWeek);
    document.getElementById('sMonth').textContent  = fmtMs(totalMonth);
    document.getElementById('sSessions').textContent = totalSessions;
    document.getElementById('sStreak').textContent  = streak;

    // Bar chart
    const maxMs = Math.max(...daily.map(d=>d.totalMs), 1);
    const avgMs = daily.reduce((s,d)=>s+d.totalMs,0) / daily.filter(d=>d.totalMs>0).length || 0;
    document.getElementById('avgLabel').textContent = avgMs > 0 ? 'avg ' + fmtMs(avgMs) : '';
    const today = new Date().toISOString().slice(0,10);
    const chartHtml = daily.map(d => {
      const pct = Math.round((d.totalMs / maxMs) * 86);
      const dayLabel = new Date(d.date + 'T12:00:00').toLocaleDateString([],{weekday:'short'}).slice(0,1);
      const isToday = d.date === today;
      return \`<div class="bar-col">
        <div class="bar-tooltip">\${d.date}<br>\${fmtMs(d.totalMs)}</div>
        <div class="bar-rect\${isToday?' today':''}" style="height:\${pct}px\${isToday?';background:var(--brand)':';background:#6366f166'}"></div>
        <div class="bar-label">\${dayLabel}</div>
      </div>\`;
    }).join('');
    document.getElementById('barChart').innerHTML = chartHtml;

    // Y labels
    const maxH = Math.ceil((maxMs / 3600000) * 2) / 2;
    document.getElementById('yLabels').innerHTML =
      [maxH, maxH/2, 0].map(h => \`<span>\${h > 0 ? h+'h' : '0'}</span>\`).join('');

    // Donut
    const monthProjects = projects.filter(p=>p.monthMs>0);
    const totalProjMs = monthProjects.reduce((s,p)=>s+p.monthMs,0) || 1;
    const svg = document.getElementById('donutSvg');
    const CIRC = 251.3; // 2π×40
    let offset = 0;
    const slices = monthProjects.slice(0,8).map(p => {
      const frac = p.monthMs / totalProjMs;
      const dash = frac * CIRC;
      const sl = \`<circle cx="50" cy="50" r="40" fill="none"
        stroke="\${p.color}" stroke-width="12"
        stroke-dasharray="\${dash} \${CIRC - dash}"
        stroke-dashoffset="\${CIRC - offset}"
        transform="rotate(-90 50 50)"/>\`;
      offset += dash;
      return {sl, p, pct: Math.round(frac*100)};
    });
    svg.innerHTML = \`<circle cx="50" cy="50" r="40" fill="none" stroke="var(--border)" stroke-width="12"/>\` +
      slices.map(s=>s.sl).join('');
    document.getElementById('donutLegend').innerHTML = slices.map(s=>
      \`<div class="donut-item">
        <div class="donut-dot" style="background:\${s.p.color}"></div>
        <div class="donut-name">\${s.p.name}</div>
        <div class="donut-pct">\${s.pct}%</div>
      </div>\`
    ).join('') || '<div style="color:var(--text-muted);font-size:12px">No data yet</div>';

    // Session table
    document.getElementById('sessionCount').textContent = totalSessions + ' total';
    const allSessions = data.allSessions || [];
    // We'll use projects sessions list from today for now - sorted reverse
    const sessionRows = projects.flatMap(p => []).slice(0,20); // placeholder
    // Actually the data doesn't include raw sessions, but the sidebar does —
    // we'll show a note here and let the user know the sync status
    const syncMsg = unsyncedCount > 0
      ? \`\${unsyncedCount} session\${unsyncedCount>1?'s':''} pending sync\`
      : lastSync > 0 ? 'All sessions synced · ' + new Date(lastSync).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : 'Not synced yet';
    document.getElementById('sessionTableBody').innerHTML =
      \`<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px">
        \${syncMsg} — <a href="#" style="color:var(--brand)" onclick="post('syncNow');return false">Sync now</a>
      </td></tr>\`;
  }

  function showToast(msg, type='info') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show ' + type;
    setTimeout(() => { t.className = 'toast'; }, 4000);
  }

  function saveApiKey() {
    const key = document.getElementById('apiKeyInput').value.trim();
    if (!key) { showToast('Enter an API key first.', 'error'); return; }
    post('setApiKey', { key });
    showToast('Saving and testing connection…', 'info');
  }

  function onApiKeyChange() { /* real-time validation could go here */ }

  function saveSetting(key, value) {
    post('setting', { key, value });
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'update')     { applyUpdate(msg); }
    if (msg.type === 'syncStatus') {
      if (msg.syncing) { showToast(msg.message, 'info'); return; }
      showToast(msg.message, msg.ok ? 'ok' : 'error');
    }
  });

  post('ready');
</script>
</body>
</html>`;
  }
}
