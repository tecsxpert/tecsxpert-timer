import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { Session, TimerState, TimerStatus, LinkedTask } from './types';
import { StorageManager } from './StorageManager';

// Simple UUID without external dependency
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function cfg() { return vscode.workspace.getConfiguration('tecsxpert-timer'); }

export class TimerManager extends EventEmitter {
  private state: TimerState = 'idle';
  private projectName = '';
  private workspacePath = '';
  private sessionStart = 0;
  private pausedAt = 0;
  private accumulatedMs = 0;

  private tickInterval: ReturnType<typeof setInterval> | undefined;
  private idleInterval: ReturnType<typeof setInterval> | undefined;
  private lastActivity = Date.now();
  private linkedTask?: LinkedTask;

  constructor(private storage: StorageManager) {
    super();
    this.watchWorkspace();
    this.startIdleDetector();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  start(projectName?: string, workspacePath?: string): void {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this.projectName  = projectName  ?? ws?.name ?? 'Unknown Project';
    this.workspacePath = workspacePath ?? ws?.uri.fsPath ?? '';

    if (this.state === 'running') { return; }

    if (this.state === 'paused') {
      // Resume — adjust sessionStart so elapsed continues from where we were
      this.sessionStart = Date.now() - this.accumulatedMs;
    } else {
      this.sessionStart = Date.now();
      this.accumulatedMs = 0;
    }

    this.state = 'running';
    this.lastActivity = Date.now();
    this.startTick();
    this.emit('statusChanged', this.getStatus());
  }

  pause(): void {
    if (this.state !== 'running') { return; }
    this.accumulatedMs = Date.now() - this.sessionStart;
    this.pausedAt = Date.now();
    this.state = 'paused';
    this.stopTick();
    this.emit('statusChanged', this.getStatus());
  }

  stop(): void {
    if (this.state === 'idle') { return; }
    const duration = this.state === 'running'
      ? Date.now() - this.sessionStart
      : this.accumulatedMs;

    if (duration > 30_000) { // only save sessions > 30 seconds
      const session: Session = {
        id: uuid(),
        projectName: this.projectName,
        workspacePath: this.workspacePath,
        startTime: this.sessionStart,
        endTime: Date.now(),
        duration,
        synced: false,
        linkedTask: this.linkedTask,
      };
      this.storage.addSession(session);
      this.emit('sessionSaved', session);
    }

    this.linkedTask = undefined;
    this.state = 'idle';
    this.accumulatedMs = 0;
    this.stopTick();
    this.emit('statusChanged', this.getStatus());
  }

  getStatus(): TimerStatus {
    const elapsed = this.state === 'running'
      ? Date.now() - this.sessionStart
      : this.accumulatedMs;

    const todaySessions = this.storage.getTodaySessions();
    const todayCompleted = todaySessions.reduce((s, x) => s + x.duration, 0);
    const todayTotal = todayCompleted + (this.state === 'running' ? elapsed : 0);

    return {
      state: this.state,
      projectName: this.projectName,
      workspacePath: this.workspacePath,
      sessionStart: this.sessionStart,
      elapsed,
      todayTotal,
    };
  }

  getState(): TimerState { return this.state; }

  setLinkedTask(task: LinkedTask | undefined): void { this.linkedTask = task; }
  getLinkedTask(): LinkedTask | undefined { return this.linkedTask; }

  recordActivity(): void {
    this.lastActivity = Date.now();
    if (this.state === 'paused') {
      // Auto-resume on activity if we were auto-paused
      if (cfg().get<boolean>('autoStart', false)) {
        this.start();
      }
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private startTick(): void {
    this.stopTick();
    this.tickInterval = setInterval(() => {
      this.emit('tick', this.getStatus());
    }, 1000);
  }

  private stopTick(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
  }

  private startIdleDetector(): void {
    this.idleInterval = setInterval(() => {
      const idleMin = cfg().get<number>('idleThresholdMinutes', 0);
      if (idleMin <= 0 || this.state !== 'running') { return; }
      const idleMs = idleMin * 60 * 1000;
      if (Date.now() - this.lastActivity > idleMs) {
        this.pause();
        vscode.window.setStatusBarMessage(
          `$(debug-pause) Tecsxpert Timer paused — idle for ${idleMin} min`, 5000
        );
      }
    }, 30_000); // check every 30 s
  }

  private watchWorkspace(): void {
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.state !== 'idle') {
        this.stop();
      }
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws && cfg().get<boolean>('autoStart', false)) {
        this.start(ws.name, ws.uri.fsPath);
      }
    });

    // Activity watchers
    vscode.workspace.onDidChangeTextDocument(() => this.recordActivity());
    vscode.window.onDidChangeTextEditorSelection(() => this.recordActivity());
    vscode.window.onDidChangeActiveTextEditor(() => this.recordActivity());
  }

  dispose(): void {
    this.stop();
    this.stopTick();
    if (this.idleInterval) { clearInterval(this.idleInterval); }
  }
}
