/**
 * Integration tests for GET /health endpoint.
 *
 * Tests against the existing HealthService-backed route:
 *   200: { ok: true, version, db: 'up', embedder: 'up', timestamp }
 *   503: { ok: false, version, db: 'down', embedder: 'up'|'down', timestamp }
 */

import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RecallServer } from '../../src/server.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { DatabaseClient } from '../../src/db/client.js';
import { HealthService } from '../../src/health.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function applyMigrations(client: DatabaseClient): Promise<void> {
  const migrationsDir = path.join(__dirname, '../../supabase/migrations');
  const files = (await fs.readdir(migrationsDir))
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await client.query(sql);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('already exists')) continue;
      throw err;
    }
  }
}

describe('GET /health', () => {
  let container: any;
  let server: RecallServer;
  let db: DatabaseClient;
  let serverUrl: string;
  let originalEnv: NodeJS.ProcessEnv;

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
    await db.registerVectorTypes();

    originalEnv = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = connectionString;
    process.env.OPENAI_API_KEY = 'test-key';

    const embedder = new MockEmbedder();
    server = new RecallServer(embedder, {
      transport: 'http',
      port: 0,
      enableDnsRebindingProtection: false,
    });
    await server.start();
    const addr = server.fastify.server.address();
    serverUrl = `http://localhost:${addr && typeof addr === 'object' ? addr.port : 0}`;
  }, 30000);

  afterAll(async () => {
    process.env = originalEnv;
    await server?.stop();
    await db?.close();
    await container?.stop();
  }, 15000);

  it('returns 200 with ok=true, db=up when healthy', async () => {
    const response = await fetch(`${serverUrl}/health`);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      ok: true,
      db: 'up',
      embedder: 'up',
      version: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it('returns 503 with ok=false, db=down when DB is unreachable', async () => {
    // HealthService has a 30-second in-memory cache for the DB check, so closing
    // the pool directly doesn't force a recheck. Instead we mock getHealth to
    // simulate degraded state and verify the route layer handles it correctly.
    const spy = vi.spyOn(HealthService.prototype, 'getHealth');
    spy.mockResolvedValue({
      ok: false,
      version: 'test',
      db: 'down',
      embedder: 'up',
      timestamp: new Date().toISOString(),
    });

    const response = await fetch(`${serverUrl}/health`);
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json).toMatchObject({ ok: false, db: 'down' });

    spy.mockRestore();
  });

  it('returns JSON content-type header', async () => {
    const response = await fetch(`${serverUrl}/health`);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });
});
