/**
 * Self-serve signup — POST /api/signup
 *
 * The public front door: email in, account + first API key out. The full key
 * is returned exactly once (only a bcrypt hash is stored); losing it means
 * issuing a new one, not recovering the old one.
 *
 * Abuse guards:
 *   - per-IP fixed-window rate limit (SIGNUP_MAX_PER_IP_HOUR, default 5/hour)
 *   - one account per email (409 on duplicate)
 *   - kill switch: SIGNUP_ENABLED=false disables the endpoint (read live so a
 *     `fly secrets set` flips it without a code change)
 *
 * New accounts always start on the free tier (100 memories).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseClient } from '../db/client.js';
import bcrypt from 'bcrypt';
import type pino from 'pino';
import { generateKeyString } from '../auth/keygen.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_KEY_ATTEMPTS = 5;
const WINDOW_MS = 60 * 60 * 1000;

interface WindowEntry {
  count: number;
  windowStart: number;
}

/** Fixed-window per-IP signup limiter (in-memory; single-instance deploy). */
export class SignupRateLimiter {
  private windows = new Map<string, WindowEntry>();

  constructor(private maxPerWindow: number) {}

  /** Returns true if this attempt is allowed (and counts it). */
  check(ip: string, now: number = Date.now()): boolean {
    this.prune(now);
    const entry = this.windows.get(ip);
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      this.windows.set(ip, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= this.maxPerWindow;
  }

  private prune(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [ip, entry] of this.windows) {
      if (now - entry.windowStart >= WINDOW_MS) this.windows.delete(ip);
    }
  }
}

/**
 * Client IP for rate limiting. Fly.io sets Fly-Client-IP on every proxied
 * request (client-supplied values are overwritten at the edge), so it is
 * trustworthy there; elsewhere we fall back to the socket address.
 */
function clientIp(request: FastifyRequest): string {
  const flyIp = request.headers['fly-client-ip'];
  if (typeof flyIp === 'string' && flyIp.length > 0) return flyIp;
  return request.ip || 'unknown';
}

export function registerSignupRoute(
  fastify: FastifyInstance,
  db: DatabaseClient,
  logger: pino.Logger,
): void {
  const maxPerHour = Number(process.env.SIGNUP_MAX_PER_IP_HOUR || 5) || 5;
  const limiter = new SignupRateLimiter(maxPerHour);

  fastify.post<{ Body: { email?: string } }>('/api/signup', async (request, reply) => {
    // Live kill switch — read per-request so a secrets change takes effect
    // on the next signup, no redeploy.
    const enabled = process.env.SIGNUP_ENABLED;
    if (enabled === 'false' || enabled === '0') {
      reply.code(503).send({ error: 'signups are temporarily disabled' });
      return;
    }

    if (!limiter.check(clientIp(request))) {
      reply.code(429).send({ error: 'too many signup attempts; try again later' });
      return;
    }

    const email = (request.body?.email || '').trim().toLowerCase();
    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
      reply.code(400).send({ error: 'a valid email address is required' });
      return;
    }

    let client;
    try {
      client = await db.getClient();
      await client.query('BEGIN');

      // 1. Create the account (free tier)
      let userId: string;
      let userCreatedAt: Date | null = null;
      try {
        const userRes = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO users (email, tier) VALUES ($1, 'free') RETURNING id, created_at`,
          [email],
        );
        userId = userRes.rows[0].id;
        userCreatedAt = userRes.rows[0].created_at;
      } catch (err: any) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
          reply.code(409).send({
            error: 'an account with this email already exists',
            hint: 'use your existing API key (POST /api/keys issues additional keys; POST /api/keys/:id/rotate replaces one)',
          });
          return;
        }
        throw err;
      }

      // 2. First API key (retry on prefix collision)
      let rawKey = '';
      let keyId = '';
      for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
        const { key, prefix } = generateKeyString();
        const hash = await bcrypt.hash(key, 12);
        try {
          const keyRes = await client.query<{ id: string }>(
            `INSERT INTO api_keys (user_id, key_hash, key_prefix, label, tier)
             VALUES ($1, $2, $3, 'signup', 'free')
             RETURNING id`,
            [userId, hash, prefix],
          );
          rawKey = key;
          keyId = keyRes.rows[0].id;
          break;
        } catch (err: any) {
          if (err.code === '23505') continue; // prefix collision → retry
          await client.query('ROLLBACK');
          throw err;
        }
      }

      if (!keyId) {
        await client.query('ROLLBACK');
        reply.code(500).send({ error: 'failed to generate a unique API key; please retry' });
        return;
      }

      await client.query('COMMIT');

      logger.info({ user_id: userId }, 'self_serve_signup');
      reply.code(200).send({
        user_id: userId,
        email,
        tier: 'free',
        api_key: rawKey, // shown exactly once — only a hash is stored
        key_id: keyId,
        created_at: userCreatedAt || new Date(),
        note: 'Save this key now. We store only a hash — it cannot be shown again.',
        next: '/connect',
      });
    } catch (err: any) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      logger.error({ error: err.message }, 'signup_failed');
      reply.code(500).send({ error: 'Internal server error' });
    } finally {
      if (client) client.release();
    }
  });
}
