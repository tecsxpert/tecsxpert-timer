import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { Session, RemoteConfig } from './types';

function cfg() { return vscode.workspace.getConfiguration('tecsxpert-timer'); }

export class ApiClient {
  private get apiKey(): string { return cfg().get<string>('apiKey', ''); }
  private get baseUrl(): string { return cfg().get<string>('apiUrl', 'https://api.tecsxpert.com'); }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const isHttps = url.protocol === 'https:';
      const payload = body ? JSON.stringify(body) : undefined;
      const opts: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 10000,
      };
      const lib = isHttps ? https : http;
      const req = lib.request(opts, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve(data as unknown as T); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      if (payload) { req.write(payload); }
      req.end();
    });
  }

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async syncSessions(sessions: Session[]): Promise<string[]> {
    if (!this.isConfigured() || sessions.length === 0) { return []; }
    const res = await this.request<{ synced: string[] }>(
      'POST', '/api/dev-timer/sessions', { sessions }
    );
    return res.synced || [];
  }

  async getRemoteConfig(): Promise<RemoteConfig | null> {
    if (!this.isConfigured()) { return null; }
    try {
      return await this.request<RemoteConfig>('GET', '/api/dev-timer/config');
    } catch {
      return null;
    }
  }

  async testConnection(): Promise<boolean> {
    if (!this.isConfigured()) { return false; }
    try {
      await this.request('GET', '/api/dev-timer/ping');
      return true;
    } catch {
      return false;
    }
  }
}
