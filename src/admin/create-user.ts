/**
 * Admin CLI — Create a user with an initial API key.
 *
 * Run: npm run admin:create-user -- --email user@example.com --tier pro [--label "initial key"]
 *
 * Opens a direct DB connection (no auth middleware), inserts the user and
 * an API key in a single transaction, prints the result as JSON to stdout.
 * The full secret is revealed exactly once here.
 */

import { parseArgs } from 'node:util';
import { randomFillSync } from 'node:crypto';
import pg from 'pg';
import bcrypt from 'bcrypt';

// ── Constants (mirrors AuthService) ──────────────────────────────
const KEY_PREFIX = 'recall_live_';
const KEY_SUFFIX_LENGTH = 32;
const KEY_PREFIX_LENGTH = 16;
const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const VALID_TIERS = ['free', 'starter', 'pro', 'team'] as const;
const MAX_KEY_ATTEMPTS = 5;

// ── Types ────────────────────────────────────────────────────────
export interface CreateUserOptions {
  email: string;
  tier: string;
  label?: string;
  databaseUrl: string;
}

export interface CreateUserResult {
  user_id: string;
  email: string;
  tier: string;
  api_key: string;
  key_id: string;
  label: string;
  created_at: string;
}

// ── Validation ───────────────────────────────────────────────────
export class CreateUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreateUserError';
  }
}

function validateEmail(email: string): void {
  // Reasonable email shape — no new deps required
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CreateUserError(`Invalid email format: "${email}"`);
  }
}

function validateTier(tier: string): void {
  if (!(VALID_TIERS as readonly string[]).includes(tier)) {
    throw new CreateUserError(
      `Invalid tier "${tier}"; must be one of: ${VALID_TIERS.join(', ')}`
    );
  }
}

// ── Key generation helpers ───────────────────────────────────────
function generateRandomSuffix(): string {
  const bytes = new Uint8Array(KEY_SUFFIX_LENGTH);
  randomFillSync(bytes);
  let suffix = '';
  for (let i = 0; i < KEY_SUFFIX_LENGTH; i++) {
    suffix += SUFFIX_CHARS[bytes[i] % SUFFIX_CHARS.length];
  }
  return suffix;
}

// ── Core operation ───────────────────────────────────────────────
export async function createUser(options: CreateUserOptions): Promise<CreateUserResult> {
  validateEmail(options.email);
  validateTier(options.tier);

  const label = options.label ?? 'initial';
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();

  try {
    await client.query('BEGIN');

    // ── Step 1: Insert user ──────────────────────────────────────
    let userId: string;
    try {
      const userRes = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO users (email, tier) VALUES ($1, $2) RETURNING id, created_at`,
        [options.email, options.tier]
      );
      userId = userRes.rows[0].id;
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        throw new CreateUserError(
          `User with email "${options.email}" already exists. Consider using the rotate endpoint to issue a new key.`
        );
      }
      throw err;
    }

    // ── Step 2: Insert API key (with collision retry) ────────────
    let rawKey = '';
    let keyId = '';

    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
      const suffix = generateRandomSuffix();
      rawKey = KEY_PREFIX + suffix;
      const keyPrefix = rawKey.slice(0, KEY_PREFIX_LENGTH);
      const hash = await bcrypt.hash(rawKey, 12);

      try {
        const keyRes = await client.query<{ id: string }>(
          `INSERT INTO api_keys (user_id, key_hash, key_prefix, label, tier)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [userId, hash, keyPrefix, label, options.tier]
        );
        keyId = keyRes.rows[0].id;
        break; // success
      } catch (err: any) {
        if (err.code === '23505') {
          continue; // key_prefix collision → retry
        }
        // Non-collision error → abort
        await client.query('ROLLBACK');
        throw err;
      }
    }

    if (!keyId) {
      await client.query('ROLLBACK');
      throw new CreateUserError(
        `Failed to generate a unique API key after ${MAX_KEY_ATTEMPTS} attempts.`
      );
    }

    await client.query('COMMIT');

    return {
      user_id: userId,
      email: options.email,
      tier: options.tier,
      api_key: rawKey,
      key_id: keyId,
      label,
      created_at: new Date().toISOString(),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

// ── CLI entry point ──────────────────────────────────────────────
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('Error: DATABASE_URL environment variable is required\n');
    process.exit(1);
  }

  let values: { email?: string; tier?: string; label?: string };
  try {
    const parsed = parseArgs({
      options: {
        email: { type: 'string', short: 'e' },
        tier: { type: 'string', short: 't' },
        label: { type: 'string', short: 'l', default: 'initial' },
      },
      strict: true,
    });
    values = parsed.values as { email?: string; tier?: string; label?: string };
  } catch {
    process.stderr.write('Error: invalid arguments\n');
    process.stderr.write(
      'Usage: npm run admin:create-user -- --email user@example.com --tier pro [--label "initial key"]\n'
    );
    process.exit(1);
  }

  if (!values.email || !values.tier) {
    process.stderr.write('Error: --email and --tier are required\n');
    process.stderr.write(
      'Usage: npm run admin:create-user -- --email user@example.com --tier pro [--label "initial key"]\n'
    );
    process.exit(1);
  }

  const result = await createUser({
    email: values.email,
    tier: values.tier,
    label: values.label || 'initial',
    databaseUrl,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// Auto-detect CLI invocation (ESM-compatible)
const scriptPath = new URL(import.meta.url).pathname;
const invokedPath = process.argv[1] ? new URL(process.argv[1], 'file://').pathname : '';
if (invokedPath && scriptPath === invokedPath) {
  main().catch((err) => {
    const message = err instanceof CreateUserError ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  });
}
