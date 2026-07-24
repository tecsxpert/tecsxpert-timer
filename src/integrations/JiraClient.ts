import * as https from 'https';

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  project: string;
  url: string;
}

export class JiraClient {
  constructor(
    private readonly domain: string,
    private readonly email: string,
    private readonly apiToken: string,
  ) {}

  private get auth(): string {
    return `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')}`;
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = https.request({
        hostname: `${this.domain}.atlassian.net`,
        port: 443,
        path,
        method,
        headers: {
          'Authorization': this.auth,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
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
            reject(new Error(`Jira ${code}: ${data.slice(0, 300)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Jira timed out')); });
      if (payload) { req.write(payload); }
      req.end();
    });
  }

  async testConnection(): Promise<boolean> {
    try { await this.request('GET', '/rest/api/3/myself'); return true; }
    catch { return false; }
  }

  async searchIssues(query: string): Promise<JiraIssue[]> {
    if (!query.trim()) { return []; }
    try {
      const res = await this.request<{ sections: Array<{ issues: Array<{ key: string; id: string; summaryText?: string; summary?: string }> }> }>(
        'GET', `/rest/api/3/issue/picker?query=${encodeURIComponent(query)}&showSubTasks=true`
      );
      return (res.sections || []).flatMap(s =>
        (s.issues || []).map(i => ({
          id: i.id,
          key: i.key,
          summary: i.summaryText || i.summary || '',
          project: i.key.split('-')[0],
          url: `https://${this.domain}.atlassian.net/browse/${i.key}`,
        }))
      );
    } catch { return []; }
  }

  async logWork(issueKey: string, durationMs: number, comment?: string): Promise<void> {
    const started = new Date().toISOString().replace(/\.\d{3}Z$/, '.000+0000');
    const body: Record<string, unknown> = { timeSpentSeconds: Math.max(60, Math.round(durationMs / 1000)), started };
    if (comment) {
      body.comment = {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }],
      };
    }
    await this.request('POST', `/rest/api/3/issue/${issueKey}/worklog`, body);
  }
}
