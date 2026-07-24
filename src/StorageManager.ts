import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Session, StorageData } from './types';

const FILE_NAME = 'tecsxpert-timer-data.json';

export class StorageManager {
  private filePath: string;
  private data: StorageData;

  constructor(ctx: vscode.ExtensionContext) {
    const dir = ctx.globalStorageUri.fsPath;
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    this.filePath = path.join(dir, FILE_NAME);
    this.data = this.load();
  }

  private load(): StorageData {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch { /* corrupt file — start fresh */ }
    return { sessions: [], lastSync: 0 };
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  addSession(session: Session): void {
    this.data.sessions.push(session);
    // Keep only last 90 days of synced sessions to avoid unbounded growth
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    this.data.sessions = this.data.sessions.filter(
      s => !s.synced || s.endTime > cutoff
    );
    this.save();
  }

  markSynced(ids: string[]): void {
    const set = new Set(ids);
    this.data.sessions.forEach(s => { if (set.has(s.id)) { s.synced = true; } });
    this.data.lastSync = Date.now();
    this.save();
  }

  markTimeLogged(id: string): void {
    const s = this.data.sessions.find(x => x.id === id);
    if (s) { s.timeLogged = true; this.save(); }
  }

  getUnsynced(): Session[] {
    return this.data.sessions.filter(s => !s.synced);
  }

  getAllSessions(): Session[] {
    return [...this.data.sessions];
  }

  getLastSync(): number {
    return this.data.lastSync;
  }

  getTodaySessions(): Session[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = today.getTime();
    return this.data.sessions.filter(s => s.endTime >= start);
  }

  getSessionsInRange(fromMs: number, toMs: number): Session[] {
    return this.data.sessions.filter(s => s.endTime >= fromMs && s.startTime <= toMs);
  }
}
