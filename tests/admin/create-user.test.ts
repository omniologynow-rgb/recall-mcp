import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcrypt';

import { createUser, CreateUserError } from '../../src/admin/create-user.js';
import { DatabaseClient } from '../../src/db/client.js';
import { AuthService } from '../../src/auth/index.js';

// ── Helpers ──────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'supabase/migrations');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'dist/admin/create-user.js');

async function applyMigrations(db: DatabaseClient): Promise<void> {
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.query(sql);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('already exists')) {
        continue; // IF NOT EXISTS handled by migration
      }
      throw err;
    }
  }
}

/**
 * Spawn the CLI script as a subprocess and return { exitCode, stdout, stderr }.
 */
function runCli(args: string[], env: Record<string, string | undefined>): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath, // node binary
      [SCRIPT_PATH, ...args],
      { env: { ...process.env, ...env } as Record<string, string> },
      (err, stdout, stderr) => {
        resolve({
          exitCode: err?.code ?? 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      }
    );
  });
}

// ── Test suite ───────────────────────────────────────────────────
describe('Admin CLI — create-user (R13)', () => {
  let container: any;
  let databaseUrl: string;
  let db: DatabaseClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg15")
      .withUsername('test')
      .withPassword('test')
      .withDatabase('testdb')
      .withExposedPorts(5432)
      .start();

    databaseUrl = `postgresql://test:test@${container.getHost()}:${container.getMappedPort(5432)}/testdb`;

    // Apply migrations for tests that query the DB directly
    db = new DatabaseClient(databaseUrl);
    await applyMigrations(db);
    await db.registerVectorTypes();
  }, 30000);

  afterAll(async () => {
    await db?.close();
    await container?.stop();
  }, 15000);

  // ── Core function tests ────────────────────────────────────────
  describe('createUser() — core function', () => {
    it('creates a user and returns the full API key with correct structure', async () => {
      const result = await createUser({
        email: 'alice@example.com',
        tier: 'pro',
        label: 'cli-created',
        databaseUrl,
      });

      // Validate result shape
      expect(result).toMatchObject({
        email: 'alice@example.com',
        tier: 'pro',
        label: 'cli-created',
      });
      expect(result.user_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.key_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.api_key).toMatch(/^recall_live_[A-Za-z0-9_-]{32}$/);
      expect(result.created_at).toBeTruthy();

      // Verify user row in DB
      const userRows = await db.query('SELECT * FROM users WHERE id = $1', [result.user_id]);
      expect(userRows.rows).toHaveLength(1);
      expect(userRows.rows[0].email).toBe('alice@example.com');
      expect(userRows.rows[0].tier).toBe('pro');

      // Verify api_key row in DB (no secret — only hash stored)
      const keyRows = await db.query(
        'SELECT * FROM api_keys WHERE id = $1',
        [result.key_id]
      );
      expect(keyRows.rows).toHaveLength(1);
      expect(keyRows.rows[0].user_id).toBe(result.user_id);
      expect(keyRows.rows[0].tier).toBe('pro');
      expect(keyRows.rows[0].label).toBe('cli-created');
      expect(keyRows.rows[0].key_hash).toBeTruthy();
      expect(keyRows.rows[0].key_hash).not.toBe(result.api_key); // hashed ≠ plaintext

      // Verify returned key authenticates against auth layer
      const auth = new AuthService(db);
      const authResult = await auth.authenticate(result.api_key);
      expect(authResult.userId).toBe(result.user_id);
      expect(authResult.tier).toBe('pro');
      expect(authResult.keyId).toBe(result.key_id);
    });

    it('defaults label to "initial" when not provided', async () => {
      const result = await createUser({
        email: 'bob@example.com',
        tier: 'free',
        databaseUrl,
      });
      expect(result.label).toBe('initial');

      const keyRows = await db.query(
        'SELECT label FROM api_keys WHERE id = $1',
        [result.key_id]
      );
      expect(keyRows.rows[0].label).toBe('initial');
    });

    it('rejects duplicate email with a clear error', async () => {
      // First call succeeds
      await createUser({
        email: 'dupe@example.com',
        tier: 'starter',
        databaseUrl,
      });

      // Second call with same email
      await expect(
        createUser({
          email: 'dupe@example.com',
          tier: 'starter',
          databaseUrl,
        })
      ).rejects.toThrow(CreateUserError);
      await expect(
        createUser({
          email: 'dupe@example.com',
          tier: 'starter',
          databaseUrl,
        })
      ).rejects.toThrow(/already exists/);
      await expect(
        createUser({
          email: 'dupe@example.com',
          tier: 'starter',
          databaseUrl,
        })
      ).rejects.toThrow(/rotate/);
    });

    it('rejects invalid tier values', async () => {
      await expect(
        createUser({
          email: 'bad-tier@example.com',
          tier: 'bogus',
          databaseUrl,
        })
      ).rejects.toThrow(CreateUserError);
      await expect(
        createUser({
          email: 'bad-tier@example.com',
          tier: 'bogus',
          databaseUrl,
        })
      ).rejects.toThrow(/invalid tier/i);
    });

    it('rejects invalid email format', async () => {
      await expect(
        createUser({
          email: 'not-an-email',
          tier: 'free',
          databaseUrl,
        })
      ).rejects.toThrow(CreateUserError);
      await expect(
        createUser({
          email: 'not-an-email',
          tier: 'free',
          databaseUrl,
        })
      ).rejects.toThrow(/invalid email/i);
    });

    it('accepts all valid tiers', async () => {
      for (const tier of ['free', 'starter', 'pro', 'team']) {
        const email = `tier-${tier}@example.com`;
        const result = await createUser({ email, tier, databaseUrl });
        expect(result.tier).toBe(tier);

        // Verify DB
        const rows = await db.query(
          'SELECT tier FROM api_keys WHERE id = $1',
          [result.key_id]
        );
        expect(rows.rows[0].tier).toBe(tier);
      }
    });

    it('no partial state on duplicate email — no second user or key created', async () => {
      const email = 'no-partial@example.com';

      // First call
      await createUser({ email, tier: 'free', databaseUrl });

      // Verify exactly 1 user
      const usersBefore = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      expect(usersBefore.rows).toHaveLength(1);

      // Second call fails
      await expect(
        createUser({ email, tier: 'free', databaseUrl })
      ).rejects.toThrow(/already exists/);

      // Still exactly 1 user (no partial state)
      const usersAfter = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      expect(usersAfter.rows).toHaveLength(1);

      // Still exactly 1 key for that user
      const keysAfter = await db.query(
        'SELECT id FROM api_keys WHERE user_id = $1',
        [usersAfter.rows[0].id]
      );
      expect(keysAfter.rows).toHaveLength(1);
    });
  });

  // ── CLI invocation tests ───────────────────────────────────────
  describe('CLI invocation', () => {
    it('succeeds with valid args and prints JSON to stdout', async () => {
      const { exitCode, stdout, stderr } = await runCli(
        ['--email', 'cli-test@example.com', '--tier', 'starter', '--label', 'from-cli'],
        { DATABASE_URL: databaseUrl }
      );

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');

      const result = JSON.parse(stdout);
      expect(result.email).toBe('cli-test@example.com');
      expect(result.tier).toBe('starter');
      expect(result.label).toBe('from-cli');
      expect(result.api_key).toMatch(/^recall_live_[A-Za-z0-9_-]{32}$/);
      expect(result.user_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('fails with non-zero exit when DATABASE_URL is missing', async () => {
      const { exitCode, stderr } = await runCli(
        ['--email', 'no-env@example.com', '--tier', 'free'],
        { DATABASE_URL: undefined } // unset
      );

      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/DATABASE_URL/);
    });

    it('fails with usage hint when --email is missing', async () => {
      const { exitCode, stderr } = await runCli(
        ['--tier', 'free'],
        { DATABASE_URL: databaseUrl }
      );

      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--email/);
      expect(stderr).toMatch(/Usage:/);
    });

    it('fails with usage hint when --tier is missing', async () => {
      const { exitCode, stderr } = await runCli(
        ['--email', 'no-tier@example.com'],
        { DATABASE_URL: databaseUrl }
      );

      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--tier/);
      expect(stderr).toMatch(/Usage:/);
    });

    it('fails with non-zero exit on duplicate email via CLI', async () => {
      // First call
      const first = await runCli(
        ['--email', 'cli-dupe@example.com', '--tier', 'pro'],
        { DATABASE_URL: databaseUrl }
      );
      expect(first.exitCode).toBe(0);

      // Second call
      const second = await runCli(
        ['--email', 'cli-dupe@example.com', '--tier', 'pro'],
        { DATABASE_URL: databaseUrl }
      );
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toMatch(/already exists/);
      expect(second.stderr).toMatch(/rotate/);
    });

    it('defaults label to "initial" when --label is omitted', async () => {
      const { exitCode, stdout } = await runCli(
        ['--email', 'default-label@example.com', '--tier', 'free'],
        { DATABASE_URL: databaseUrl }
      );

      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.label).toBe('initial');
    });
  });
});
