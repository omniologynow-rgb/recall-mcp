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

describe('Full-account export (P0 — "your data leaves with you")', () => {
  let container: any;
  let server: RecallServer;
  let db: DatabaseClient;
  let originalEnv: NodeJS.ProcessEnv;
  let apiKey: string;
  let email: string;

  let ipCounter = 100;

  async function signupUser(): Promise<{ api_key: string; email: string }> {
    const userEmail = `export-${randomUUID()}@example.com`;
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/signup',
      headers: {
        'content-type': 'application/json',
        'fly-client-ip': `10.2.3.${ipCounter++}`,
      },
      payload: JSON.stringify({ email: userEmail }),
    });
    expect(res.statusCode).toBe(200);
    return { api_key: res.json().api_key, email: userEmail };
  }

  async function remember(key: string, content: string, namespace?: string, metadata?: object) {
    const args: Record<string, unknown> = { content };
    if (namespace) args.namespace = namespace;
    if (metadata) args.metadata = metadata;
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({
        jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
        params: { name: 'remember', arguments: args },
      }),
    });
    expect(res.statusCode).toBe(200);
    const inner = JSON.parse(res.json().result.content[0].text);
    expect(inner).toHaveProperty('id');
    return inner.id as string;
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

    server = new RecallServer(new MockEmbedder(), {
      transport: 'http',
      port: 0,
      enableDnsRebindingProtection: false,
    });
    await server.start();

    const account = await signupUser();
    apiKey = account.api_key;
    email = account.email;
  }, 120_000);

  afterAll(async () => {
    if (server) await server.stop();
    process.env = originalEnv;
    if (db) await db.close();
    if (container) await container.stop();
  }, 60_000);

  it('read-after-write: memories written via MCP appear in the export, across all namespaces', async () => {
    await remember(apiKey, 'My dog is named Biscuit.');
    await remember(apiKey, 'Prefers TypeScript over Python.', 'preferences', { source: 'test' });
    await remember(apiKey, 'Warm, curious, allergic to hype.', 'persona');

    const res = await server.fastify.inject({
      method: 'GET',
      url: '/api/export',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('recall-export-');

    const body = res.json();
    expect(body.format).toBe('recall.export');
    expect(body.format_version).toBe(1);
    expect(body.account.email).toBe(email);
    expect(body.account.tier).toBe('free');
    expect(body.memory_count).toBe(3);
    expect(body.namespaces).toEqual(['default', 'persona', 'preferences']);

    const contents = body.memories.map((m: any) => m.content);
    expect(contents).toContain('My dog is named Biscuit.');
    expect(contents).toContain('Prefers TypeScript over Python.');
    expect(contents).toContain('Warm, curious, allergic to hype.');

    // persona memory carries its namespace; metadata survives; embeddings do NOT leak
    const persona = body.memories.find((m: any) => m.namespace === 'persona');
    expect(persona).toBeDefined();
    const prefs = body.memories.find((m: any) => m.namespace === 'preferences');
    expect(prefs.metadata).toEqual({ source: 'test' });
    for (const m of body.memories) {
      expect(m).not.toHaveProperty('embedding');
      expect(m).not.toHaveProperty('content_hash');
      expect(m).not.toHaveProperty('user_id');
      expect(m.created_at).toBeTruthy();
    }
  });

  it('authenticates via ?key= too (connector-style clients)', async () => {
    const res = await server.fastify.inject({
      method: 'GET',
      url: `/api/export?key=${apiKey}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().memory_count).toBeGreaterThan(0);
  });

  it('rejects unauthenticated and bad-key requests with 401', async () => {
    const noAuth = await server.fastify.inject({ method: 'GET', url: '/api/export' });
    expect(noAuth.statusCode).toBe(401);
    const badKey = await server.fastify.inject({
      method: 'GET',
      url: '/api/export',
      headers: { authorization: 'Bearer recall_live_00000000000000000000000000000000' },
    });
    expect(badKey.statusCode).toBe(401);
  });

  it('exports an empty account honestly (0 memories, empty namespaces)', async () => {
    const fresh = await signupUser();
    const res = await server.fastify.inject({
      method: 'GET',
      url: '/api/export',
      headers: { authorization: `Bearer ${fresh.api_key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.memory_count).toBe(0);
    expect(body.memories).toEqual([]);
    expect(body.namespaces).toEqual([]);
  });

  it('is isolated per user: one account never exports another account\'s memories', async () => {
    const other = await signupUser();
    await remember(other.api_key, 'Secret belonging to the other user.');
    const res = await server.fastify.inject({
      method: 'GET',
      url: '/api/export',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const contents = res.json().memories.map((m: any) => m.content);
    expect(contents).not.toContain('Secret belonging to the other user.');
  });
});
