import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RecallServer } from '../../src/server.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { DatabaseClient } from '../../src/db/client.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function applyMigrations(client: DatabaseClient) {
  const migrationsDir = path.join(__dirname, '../../supabase/migrations');
  const files = (await fs.readdir(migrationsDir))
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const migrationSql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await client.query(migrationSql);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('already exists'))) {
        throw err;
      }
    }
  }
}

describe('Self-serve signup (P0)', () => {
  let container: any;
  let server: RecallServer;
  let db: DatabaseClient;
  let originalEnv: NodeJS.ProcessEnv;

  // Each test uses its own simulated client IP so the per-IP signup limiter
  // never couples tests together.
  let ipCounter = 0;
  function nextIp(): string {
    ipCounter++;
    return `10.1.2.${ipCounter}`;
  }

  function signup(email: string, ip?: string) {
    return server.fastify.inject({
      method: 'POST',
      url: '/api/signup',
      headers: {
        'content-type': 'application/json',
        'fly-client-ip': ip || nextIp(),
      },
      payload: JSON.stringify({ email }),
    });
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg15')
      .withDatabase('testdb')
      .withUsername('test')
      .withPassword('test')
      .withExposedPorts(5432)
      .start();

    const connectionString = `postgresql://test:test@${container.getHost()}:${container.getPort()}/testdb`;
    db = new DatabaseClient(connectionString);
    await applyMigrations(db);

    originalEnv = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = connectionString;
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.SIGNUP_ENABLED;

    server = new RecallServer(new MockEmbedder(), {
      transport: 'http',
      port: 0,
      enableDnsRebindingProtection: false,
    });
    await server.start();
  }, 120_000);

  afterAll(async () => {
    if (server) await server.stop();
    process.env = originalEnv;
    if (db) await db.close();
    if (container) await container.stop();
  }, 60_000);

  it('creates an account and returns the key exactly once (correct format, free tier)', async () => {
    const email = `signup-${randomUUID()}@example.com`;
    const res = await signup(email);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe(email);
    expect(body.tier).toBe('free');
    expect(body.api_key).toMatch(/^recall_live_[A-Za-z0-9_-]{32}$/);
    expect(body.user_id).toBeTruthy();
    expect(body.key_id).toBeTruthy();
    // Only a hash is stored — the raw key never appears in the database
    const keyRow = await db.query('SELECT key_hash FROM api_keys WHERE id = $1', [body.key_id]);
    expect(keyRow.rows[0].key_hash).not.toContain(body.api_key);
  });

  it('read-after-write: the returned key authenticates immediately for key management AND MCP tools', async () => {
    const email = `raw-${randomUUID()}@example.com`;
    const res = await signup(email);
    expect(res.statusCode).toBe(200);
    const { api_key } = res.json();

    // 1. Key management works with the fresh key
    const keysRes = await server.fastify.inject({
      method: 'GET',
      url: '/api/keys',
      headers: { authorization: `Bearer ${api_key}` },
    });
    expect(keysRes.statusCode).toBe(200);
    expect(keysRes.json()).toHaveLength(1);

    // 2. Full MCP roundtrip: remember → recall with the fresh key
    const rememberRes = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${api_key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'remember', arguments: { content: 'My dog is named Biscuit.' } },
      }),
    });
    expect(rememberRes.statusCode).toBe(200);
    const rememberBody = rememberRes.json();
    expect(JSON.parse(rememberBody.result.content[0].text)).toHaveProperty('id');

    const recallRes = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${api_key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'recall', arguments: { query: 'My dog is named Biscuit.', threshold: 0.1 } },
      }),
    });
    expect(recallRes.statusCode).toBe(200);
    expect(recallRes.json().result.content[0].text).toContain('Biscuit');
  });

  it('accepts the key via ?key= on /mcp (connector-UI clients without header fields)', async () => {
    const email = `urlkey-${randomUUID()}@example.com`;
    const { api_key } = (await signup(email)).json();

    const res = await server.fastify.inject({
      method: 'POST',
      url: `/mcp?key=${api_key}`,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(res.statusCode).toBe(200);
    const tools = res.json().result.tools.map((t: any) => t.name);
    expect(tools).toContain('remember');
    expect(tools).toContain('recall');
  });

  it('rejects a duplicate email with 409 and a self-serve hint', async () => {
    const email = `dupe-${randomUUID()}@example.com`;
    expect((await signup(email)).statusCode).toBe(200);
    const second = await signup(email);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain('already exists');
  });

  it('rejects invalid emails with 400', async () => {
    for (const bad of ['', 'nope', 'a@b', 'has space@x.com']) {
      const res = await signup(bad);
      expect(res.statusCode).toBe(400);
    }
  });

  it('rate-limits repeated signups from one IP', async () => {
    const ip = '10.9.9.9';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await signup(`burst-${i}-${randomUUID()}@example.com`, ip);
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it('honors the SIGNUP_ENABLED kill switch live (no restart)', async () => {
    process.env.SIGNUP_ENABLED = 'false';
    try {
      const res = await signup(`gated-${randomUUID()}@example.com`);
      expect(res.statusCode).toBe(503);
    } finally {
      delete process.env.SIGNUP_ENABLED;
    }
    const after = await signup(`ungated-${randomUUID()}@example.com`);
    expect(after.statusCode).toBe(200);
  });

  describe('product site pages', () => {
    const pages: Array<[string, string]> = [
      ['/', 'memory, everywhere you go'],
      ['/signup', 'Get your key'],
      ['/export', 'Your data leaves with you'],
      ['/connect', 'Connect your client'],
      ['/connect/claude', 'claude.ai'],
      ['/connect/claude-code', 'claude mcp add'],
      ['/connect/chatgpt', 'Developer mode'],
      ['/connect/cursor', 'mcp.json'],
      ['/connect/windsurf', 'mcp_config.json'],
      ['/connect/other-clients', 'Gemini CLI'],
      ['/connect/any', 'it speaks Recall'],
    ];

    for (const [route, marker] of pages) {
      it(`serves ${route}`, async () => {
        const res = await server.fastify.inject({ method: 'GET', url: route });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.body).toContain(marker);
      });
    }

    it('every connect guide ends with the 30-second test', async () => {
      const guides = ['/connect/claude', '/connect/claude-code', '/connect/chatgpt',
        '/connect/cursor', '/connect/windsurf', '/connect/other-clients', '/connect/any'];
      for (const route of guides) {
        const res = await server.fastify.inject({ method: 'GET', url: route });
        expect(res.body).toContain('30-second test');
        expect(res.body).toContain('Biscuit');
      }
    });

    it('serves the shared assets with correct content types', async () => {
      const css = await server.fastify.inject({ method: 'GET', url: '/assets/site.css' });
      expect(css.statusCode).toBe(200);
      expect(css.headers['content-type']).toContain('text/css');
      const js = await server.fastify.inject({ method: 'GET', url: '/assets/site.js' });
      expect(js.statusCode).toBe(200);
      expect(js.headers['content-type']).toContain('text/javascript');
    });

    it('unknown site paths 404 (whitelist routing, no traversal surface)', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: '/connect/../package.json' });
      expect([400, 404]).toContain(res.statusCode);
      const res2 = await server.fastify.inject({ method: 'GET', url: '/connect/nope' });
      expect(res2.statusCode).toBe(404);
    });
  });
});
