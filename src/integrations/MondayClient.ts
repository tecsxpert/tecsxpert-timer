import * as https from 'https';

export interface MondayBoard { id: string; name: string; }
export interface MondayItem  { id: string; name: string; }

export class MondayClient {
  constructor(private readonly apiToken: string) {}

  private graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ query, variables });
      const req = https.request({
        hostname: 'api.monday.com',
        port: 443,
        path: '/v2',
        method: 'POST',
        headers: {
          'Authorization': this.apiToken,
          'Content-Type': 'application/json',
          'API-Version': '2023-10',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 12000,
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.errors?.length) { reject(new Error(json.errors[0].message)); return; }
            resolve(json.data as T);
          } catch { reject(new Error(`Monday parse error: ${data.slice(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Monday timed out')); });
      req.write(payload);
      req.end();
    });
  }

  async testConnection(): Promise<boolean> {
    try { await this.graphql('query { me { id } }'); return true; }
    catch { return false; }
  }

  async getBoards(): Promise<MondayBoard[]> {
    const res = await this.graphql<{ boards: MondayBoard[] }>(
      'query { boards(limit: 50, order_by: used_at) { id name } }'
    );
    return res.boards || [];
  }

  async searchItems(boardId: string, query: string): Promise<MondayItem[]> {
    if (!query.trim()) { return []; }
    try {
      const res = await this.graphql<{ boards: Array<{ items_page: { items: MondayItem[] } }> }>(
        `query($boardId: [ID!]!, $query: String!) {
          boards(ids: $boardId) {
            items_page(limit: 20, query_params: {
              rules: [{ column_id: "name", compare_value: [$query], operator: contains_text }]
            }) { items { id name } }
          }
        }`,
        { boardId: [boardId], query }
      );
      return res.boards?.[0]?.items_page?.items || [];
    } catch { return []; }
  }

  async logTimeAsUpdate(itemId: string, durationMs: number, projectName: string): Promise<void> {
    const h = Math.floor(durationMs / 3600000);
    const m = Math.floor((durationMs % 3600000) / 60000);
    const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
    await this.graphql(
      `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId, body: `⏱ **${timeStr}** logged via Tecsxpert Timer — Project: ${projectName}` }
    );
  }
}
