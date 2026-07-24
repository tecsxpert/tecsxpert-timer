import * as https from 'https';

export interface ClickUpWorkspace { id: string; name: string; }
export interface ClickUpTask { id: string; name: string; status?: string; list?: { name: string }; url?: string; }

export class ClickUpClient {
  constructor(private readonly apiToken: string) {}

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = https.request({
        hostname: 'api.clickup.com',
        port: 443,
        path: `/api/v2${path}`,
        method,
        headers: {
          'Authorization': this.apiToken,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 10000,
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          const code = res.statusCode || 0;
          if (code >= 200 && code < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve(data as unknown as T); }
          } else {
            reject(new Error(`ClickUp ${code}: ${data.slice(0, 300)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('ClickUp timed out')); });
      if (payload) { req.write(payload); }
      req.end();
    });
  }

  async testConnection(): Promise<boolean> {
    try { await this.request('GET', '/team'); return true; }
    catch { return false; }
  }

  async getWorkspaces(): Promise<ClickUpWorkspace[]> {
    const res = await this.request<{ teams: ClickUpWorkspace[] }>('GET', '/team');
    return res.teams || [];
  }

  async searchTasks(workspaceId: string, query: string): Promise<ClickUpTask[]> {
    if (!query.trim()) { return []; }
    try {
      const res = await this.request<{ tasks: ClickUpTask[] }>(
        'GET', `/team/${workspaceId}/task?query=${encodeURIComponent(query)}&include_closed=false&page=0`
      );
      return res.tasks || [];
    } catch { return []; }
  }

  async logTime(taskId: string, durationMs: number, description?: string): Promise<void> {
    await this.request('POST', `/task/${taskId}/time`, {
      start: Date.now() - durationMs,
      duration: durationMs,
      description: description || 'Logged via Tecsxpert Timer',
    });
  }
}
