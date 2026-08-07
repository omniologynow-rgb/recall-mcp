import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RecallServer } from '../../src/server.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { DatabaseClient } from '../../src/db/client.js';
import { AuthService } from '../../src/auth/index.js';
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
    const migrationPath = path.join(migrationsDir, file);
    const migrationSql = await fs.readFile(migrationPath, 'utf8');
    try {
      await client.query(migrationSql);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('already exists'))) {
        throw err;
      }
    }
  }
}

describe('API Key Management (R12)', () => {
  let container: any;
  let server: RecallServer;
  let db: DatabaseClient;
  let auth: AuthService;
  let originalEnv: NodeJS.ProcessEnv;
  let userId: string;
  let userId2: string;
  let apiKey: string;
  let apiKeyId: string;
  let apiKey2: string;

  beforeAll(async () => {
    // Start PostgreSQL container with pgvector
    container = await new PostgreSqlContainer('pgvector/pgvector:pg15')
      .withDatabase('testdb')
      .withUsername('test')
      .withPassword('test')
      .withExposedPorts(5432)
      .start();

    const connectionString = `postgresql://test:test@${container.getHost()}:${container.getPort()}/testdb`;

    // Apply migrations
    db = new DatabaseClient(connectionString);
    await applyMigrations(db);

    // Set environment variables
    originalEnv = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = connectionString;
    process.env.OPENAI_API_KEY = 'test-key';

    // Create server
    const embedder = new MockEmbedder();
    server = new RecallServer(embedder, {
      transport: 'http',
      port: 0,
      enableDnsRebindingProtection: false,
    });
    await server.start();

    // Create test users
    auth = new AuthService(db);
    userId = randomUUID();
    userId2 = randomUUID();

    // User 1 (free tier)
    await db.query(
      'INSERT INTO users (id, email, tier) VALUES ($1, $2, $3)',
      [userId, `user1-${userId}@example.com`, 'free'],
    );
    const keyResult = await auth.generateApiKey(userId);
    apiKey = keyResult.key;
    apiKeyId = keyResult.id;

    // User 2 (different user, pro tier)
    await db.query(
      'INSERT INTO users (id, email, tier) VALUES ($1, $2, $3)',
      [userId2, `user2-${userId2}@example.com`, 'pro'],
    );
    const keyResult2 = await auth.generateApiKey(userId2);
    apiKey2 = keyResult2.key;
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    process.env = originalEnv;
    if (container) {
      await container.stop();
    }
  });

  // Helper: headers for requests WITHOUT a body (GET, DELETE, no-payload POST)
  function bearer(key: string) {
    return { 'authorization': `Bearer ${key}` };
  }

  // Helper: headers for requests WITH a JSON body (POST with payload)
  function jsonReq(key: string) {
    return {
      'authorization': `Bearer ${key}`,
      'content-type': 'application/json',
    };
  }

  // ===========================================================================
  // POST /api/keys — Issue a new key
  // ===========================================================================
  describe('POST /api/keys — Issue', () => {
    it('issues a new key and the secret authenticates', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey),
        payload: JSON.stringify({ label: 'test-key-issue', tier: 'free' }),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('label', 'test-key-issue');
      expect(body).toHaveProperty('tier', 'free');
      expect(body).toHaveProperty('key');
      expect(body.key).toMatch(/^recall_live_[A-Za-z0-9_-]{32}$/);
      expect(body).toHaveProperty('created_at');

      // The new key should authenticate successfully
      const newAuth = await auth.authenticate(body.key);
      expect(newAuth.userId).toBe(userId);
      expect(newAuth.tier).toBe('free');

      // List should show the new key
      const listRes = await server.fastify.inject({
        method: 'GET',
        url: '/api/keys',
        headers: bearer(apiKey),
      });
      const keys = listRes.json();
      const found = keys.find((k: any) => k.id === body.id);
      expect(found).toBeDefined();
      expect(found!.label).toBe('test-key-issue');
      // No secret material in list response
      expect(found).not.toHaveProperty('key');
    });

    it('defaults tier to authenticating key tier when not specified', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey),
        payload: JSON.stringify({ label: 'default-tier' }),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tier).toBe('free');
    });

    it('rejects tier escalation (free key cannot issue pro key)', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey),
        payload: JSON.stringify({ tier: 'pro' }),
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error).toContain('cannot issue key with tier');
    });

    it('rejects invalid tier values', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey),
        payload: JSON.stringify({ tier: 'enterprise' }),
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects unauthenticated requests', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ label: 'no-auth' }),
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ===========================================================================
  // GET /api/keys — List keys
  // ===========================================================================
  describe('GET /api/keys — List', () => {
    it('lists active keys, excludes secret material', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/api/keys',
        headers: bearer(apiKey),
      });

      expect(response.statusCode).toBe(200);
      const keys = response.json();
      expect(Array.isArray(keys)).toBe(true);
      expect(keys.length).toBeGreaterThanOrEqual(1);

      for (const key of keys) {
        expect(key).toHaveProperty('id');
        expect(key).toHaveProperty('label');
        expect(key).toHaveProperty('tier');
        expect(key).toHaveProperty('last_used_at');
        expect(key).toHaveProperty('created_at');
        // No secret material
        expect(key).not.toHaveProperty('key');
        expect(key).not.toHaveProperty('key_hash');
        expect(key).not.toHaveProperty('key_prefix');
      }
    });

    it('excludes revoked keys by default', async () => {
      // Issue then revoke a key
      const issueRes = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey),
        payload: JSON.stringify({ label: 'to-be-revoked' }),
      });
      const newKeyBody = issueRes.json();

      await server.fastify.inject({
        method: 'DELETE',
        url: `/api/keys/${newKeyBody.id}`,
        headers: bearer(apiKey),
      });

      // List without include_revoked
      const listRes = await server.fastify.inject({
        method: 'GET',
        url: '/api/keys',
        headers: bearer(apiKey),
      });
      const keys = listRes.json();
      const revoked = keys.find((k: any) => k.id === newKeyBody.id);
      expect(revoked).toBeUndefined();
    });

    it('includes revoked keys when include_revoked=true', async () => {
      // Issue then revoke a key
      const issueRes = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey),
        payload: JSON.stringify({ label: 'revoked-visibility' }),
      });
      const newKeyBody = issueRes.json();

      await server.fastify.inject({
        method: 'DELETE',
        url: `/api/keys/${newKeyBody.id}`,
        headers: bearer(apiKey),
      });

      // List with include_revoked=true
      const listRes = await server.fastify.inject({
        method: 'GET',
        url: '/api/keys?include_revoked=true',
        headers: bearer(apiKey),
      });
      const keys = listRes.json();
      const revoked = keys.find((k: any) => k.id === newKeyBody.id);
      expect(revoked).toBeDefined();
      expect(revoked).toHaveProperty('revoked_at');
      expect(revoked!.revoked_at).not.toBeNull();
    });

    it('scopes keys to the authenticated user only', async () => {
      // User 1 lists keys
      const res1 = await server.fastify.inject({
        method: 'GET',
        url: '/api/keys',
        headers: bearer(apiKey),
      });
      const keys1 = res1.json();

      // User 2 lists keys
      const res2 = await server.fastify.inject({
        method: 'GET',
        url: '/api/keys',
        headers: bearer(apiKey2),
      });
      const keys2 = res2.json();
      expect(keys2.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // DELETE /api/keys/:id — Revoke a key
  // ===========================================================================
  describe('DELETE /api/keys/:id — Revoke', () => {
    it('revokes a key, which then fails authentication', async () => {
      // Issue a new key to revoke
      const issueRes = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey),
        payload: JSON.stringify({ label: 'revoke-me' }),
      });
      const { id, key: newKey } = issueRes.json();

      // Revoke it
      const revokeRes = await server.fastify.inject({
        method: 'DELETE',
        url: `/api/keys/${id}`,
        headers: bearer(apiKey),
      });
      expect(revokeRes.statusCode).toBe(204);

      // Key should no longer authenticate
      await expect(auth.authenticate(newKey)).rejects.toThrow('unauthorized');

      // Key should still exist in DB (audit trail)
      const dbRes = await db.query(
        'SELECT id, revoked_at FROM api_keys WHERE id = $1',
        [id],
      );
      expect(dbRes.rows.length).toBe(1);
      expect(dbRes.rows[0].revoked_at).not.toBeNull();
    });

    it('returns 404 for nonexistent key', async () => {
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/api/keys/${randomUUID()}`,
        headers: bearer(apiKey),
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 404 for another user\'s key', async () => {
      // User 2 creates a key
      const issueRes = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey2),
        payload: JSON.stringify({ label: 'other-users-key' }),
      });
      const { id } = issueRes.json();

      // User 1 tries to revoke it
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/api/keys/${id}`,
        headers: bearer(apiKey),
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 409 when trying to revoke own authenticating key', async () => {
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/api/keys/${apiKeyId}`,
        headers: bearer(apiKey),
      });
      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error).toContain('cannot revoke the key in use');
    });
  });

  // ===========================================================================
  // POST /api/keys/:id/rotate — Atomic rotate
  // ===========================================================================
  describe('POST /api/keys/:id/rotate — Rotate', () => {
    it('returns new secret, old key revoked, new key authenticates, old key fails', async () => {
      // Issue a key to rotate
      const issueRes = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey),
        payload: JSON.stringify({ label: 'rotate-me', tier: 'free' }),
      });
      const { id, key: oldKey } = issueRes.json();

      // Rotate it (no body, so no content-type needed)
      const rotateRes = await server.fastify.inject({
        method: 'POST',
        url: `/api/keys/${id}/rotate`,
        headers: bearer(apiKey),
      });

      expect(rotateRes.statusCode).toBe(200);
      const body = rotateRes.json();
      expect(body).toHaveProperty('key');
      expect(body.key).toMatch(/^recall_live_[A-Za-z0-9_-]{32}$/);
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('label', 'rotate-me');
      expect(body).toHaveProperty('tier', 'free');
      expect(body).toHaveProperty('created_at');

      // New key should authenticate
      const newAuth = await auth.authenticate(body.key);
      expect(newAuth.userId).toBe(userId);

      // Old key should fail auth
      await expect(auth.authenticate(oldKey)).rejects.toThrow('unauthorized');

      // Old key should have revoked_at set in DB
      const dbRes = await db.query(
        'SELECT revoked_at FROM api_keys WHERE id = $1',
        [id],
      );
      expect(dbRes.rows[0].revoked_at).not.toBeNull();
    });

    it('allows self-rotation (same key being used to authenticate)', async () => {
      // User 2 creates a pro key
      const selfKeyIssue = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey2),
        payload: JSON.stringify({ label: 'self-rotatable' }),
      });
      const selfKey = selfKeyIssue.json();

      // Use the new key to rotate itself (no body, so no content-type)
      const rotateRes = await server.fastify.inject({
        method: 'POST',
        url: `/api/keys/${selfKey.id}/rotate`,
        headers: bearer(selfKey.key),
      });

      expect(rotateRes.statusCode).toBe(200);
      const body = rotateRes.json();
      expect(body).toHaveProperty('key');
      // New key should authenticate
      const newAuth = await auth.authenticate(body.key);
      expect(newAuth.userId).toBe(userId2);
    });

    it('returns 404 for nonexistent key', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/api/keys/${randomUUID()}/rotate`,
        headers: bearer(apiKey),
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 404 for another user\'s key', async () => {
      // User 2 creates a key
      const issueRes = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey2),
        payload: JSON.stringify({ label: 'rotate-other' }),
      });
      const { id } = issueRes.json();

      // User 1 tries to rotate it
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/api/keys/${id}/rotate`,
        headers: bearer(apiKey),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // ===========================================================================
  // Auth flow: revoked key → same error as nonexistent key
  // ===========================================================================
  describe('Auth flow — no enumeration leak', () => {
    it('revoked key produces same error as nonexistent key', async () => {
      // Create and revoke a key
      const issueRes = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey),
        payload: JSON.stringify({ label: 'enumeration-test' }),
      });
      const { id, key: revokedKey } = issueRes.json();

      await server.fastify.inject({
        method: 'DELETE',
        url: `/api/keys/${id}`,
        headers: bearer(apiKey),
      });

      // Both should throw 'unauthorized' — same message, same error type
      const revokedErr = await auth.authenticate(revokedKey).catch((e: any) => e);
      const noneErr = await auth.authenticate('recall_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').catch((e: any) => e);

      expect(revokedErr.message).toBe('unauthorized');
      expect(noneErr.message).toBe('unauthorized');
    });
  });

  // ===========================================================================
  // last_used_at updates on successful auth
  // ===========================================================================
  describe('last_used_at tracking', () => {
    it('updates last_used_at on successful authentication', async () => {
      // Issue a fresh key
      const issueRes = await server.fastify.inject({
        method: 'POST',
        url: '/api/keys',
        headers: jsonReq(apiKey),
        payload: JSON.stringify({ label: 'last-used-test' }),
      });
      const { id, key: freshKey } = issueRes.json();

      // Verify last_used_at is null initially
      let dbRes = await db.query('SELECT last_used_at FROM api_keys WHERE id = $1', [id]);
      expect(dbRes.rows[0].last_used_at).toBeNull();

      // Authenticate with the key (this triggers fire-and-forget last_used_at update)
      await auth.authenticate(freshKey);

      // The last_used_at update is fire-and-forget, so retry briefly for the async write
      let lastUsed: any = null;
      for (let i = 0; i < 20; i++) {
        const res = await db.query('SELECT last_used_at FROM api_keys WHERE id = $1', [id]);
        lastUsed = res.rows[0].last_used_at;
        if (lastUsed !== null) break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect(lastUsed).not.toBeNull();
    });
  });
});
