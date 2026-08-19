import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '../db/client.js';
import type { AuthService } from '../auth/index.js';
import bcrypt from 'bcrypt';
import type pino from 'pino';

import { generateKeyString } from '../auth/keygen.js';
import { extractApiKey } from '../auth/extract.js';

const VALID_TIERS = ['free', 'starter', 'pro', 'team'] as const;
const TIER_ORDER: Record<string, number> = { free: 0, starter: 1, pro: 2, team: 3 };

export function registerApiKeyRoutes(
  fastify: FastifyInstance,
  db: DatabaseClient,
  auth: AuthService,
  logger: pino.Logger,
): void {
  // ---------------------------------------------------------------------------
  // POST /api/keys — issue a new key for the authenticated user
  // ---------------------------------------------------------------------------
  fastify.post<{
    Body: { label?: string; tier?: string };
  }>('/api/keys', { preHandler: authPreHandler(auth) }, async (request, reply) => {
    const authInfo = (request.raw as any)._auth;
    const { label, tier } = request.body || {};

    // Validate tier if provided
    let effectiveTier = tier;
    if (effectiveTier) {
      if (!VALID_TIERS.includes(effectiveTier as any)) {
        reply.code(400).send({
          error: `invalid tier "${effectiveTier}"; must be one of: ${VALID_TIERS.join(', ')}`,
        });
        return;
      }
    } else {
      // Default to authenticating key's tier
      const keyRes = await db.query<{ tier: string }>(
        'SELECT tier FROM api_keys WHERE id = $1',
        [authInfo.keyId],
      );
      effectiveTier = keyRes.rows[0]?.tier || 'free';
    }

    // Tier escalation guard
    const authTier = authInfo.tier || 'free';
    if ((TIER_ORDER[effectiveTier] ?? 0) > (TIER_ORDER[authTier] ?? 0)) {
      reply.code(403).send({
        error: `cannot issue key with tier "${effectiveTier}" from tier "${authTier}" authenticating key`,
      });
      return;
    }

    try {
      const genFields: { label?: string; tier?: string } = {};
      if (label) { genFields.label = label; }
      genFields.tier = effectiveTier;
      const result = await auth.generateApiKey(authInfo.userId, genFields);

      const keyRow = await db.query<{ created_at: Date }>(
        'SELECT created_at FROM api_keys WHERE id = $1',
        [result.id],
      );

      reply.code(200).send({
        id: result.id,
        label: label || null,
        tier: effectiveTier,
        key: result.key,
        created_at: keyRow.rows[0]?.created_at || new Date().toISOString(),
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to issue API key');
      reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/keys — list active keys for the authenticated user
  // ---------------------------------------------------------------------------
  fastify.get<{
    Querystring: { include_revoked?: string };
  }>('/api/keys', { preHandler: authPreHandler(auth) }, async (request, reply) => {
    const authInfo = (request.raw as any)._auth;
    const includeRevoked = request.query?.include_revoked === 'true';

    try {
      const rows = await db.query<{
        id: string;
        label: string | null;
        tier: string;
        last_used_at: Date | null;
        created_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT id, label, tier, last_used_at, created_at${includeRevoked ? ', revoked_at' : ''}
         FROM api_keys
         WHERE user_id = $1
           ${includeRevoked ? '' : 'AND revoked_at IS NULL'}
         ORDER BY created_at DESC`,
        [authInfo.userId],
      );

      reply.code(200).send(
        rows.rows.map((r) => {
          const entry: Record<string, any> = {
            id: r.id,
            label: r.label,
            tier: r.tier,
            last_used_at: r.last_used_at,
            created_at: r.created_at,
          };
          if (includeRevoked) {
            entry.revoked_at = r.revoked_at;
          }
          return entry;
        }),
      );
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to list API keys');
      reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/keys/:id — revoke a key
  // ---------------------------------------------------------------------------
  fastify.delete<{
    Params: { id: string };
  }>('/api/keys/:id', { preHandler: authPreHandler(auth) }, async (request, reply) => {
    const authInfo = (request.raw as any)._auth;
    const { id } = request.params;

    // Self-revocation guard
    if (id === authInfo.keyId) {
      reply.code(409).send({
        error: 'cannot revoke the key in use; rotate or use another key first',
      });
      return;
    }

    try {
      const result = await db.query(
        `UPDATE api_keys
         SET revoked_at = NOW()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [id, authInfo.userId],
      );

      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }

      reply.code(204).send();
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to revoke API key');
      reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/keys/:id/rotate — atomic rotate (issue new + revoke old)
  // ---------------------------------------------------------------------------
  fastify.post<{
    Params: { id: string };
  }>('/api/keys/:id/rotate', { preHandler: authPreHandler(auth) }, async (request, reply) => {
    const authInfo = (request.raw as any)._auth;
    const { id } = request.params;

    let client;
    try {
      client = await db.getClient();
      await client.query('BEGIN');

      // Lock the old key row and verify ownership + not already revoked
      const oldKeyRes = await client.query<{
        id: string;
        user_id: string;
        tier: string;
        label: string | null;
      }>(
        'SELECT id, user_id, tier, label FROM api_keys WHERE id = $1 FOR UPDATE',
        [id],
      );

      if (oldKeyRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404).send({ error: 'Not found' });
        return;
      }

      const oldKey = oldKeyRes.rows[0];

      // Ownership check
      if (oldKey.user_id !== authInfo.userId) {
        await client.query('ROLLBACK');
        reply.code(404).send({ error: 'Not found' });
        return;
      }

      // Generate new key (retry on prefix collision)
      let newKey: string | null = null;
      let newKeyId: string = '';
      const maxAttempts = 5;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { key, prefix } = generateKeyString();
        const hash = await bcrypt.hash(key, 12);

        try {
          const insertRes = await client.query<{ id: string }>(
            `INSERT INTO api_keys (user_id, key_hash, key_prefix, label, tier)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [authInfo.userId, hash, prefix, oldKey.label, oldKey.tier],
          );
          newKey = key;
          newKeyId = insertRes.rows[0].id;
          break;
        } catch (insertErr: any) {
          if (insertErr.code === '23505') {
            continue; // duplicate prefix, retry
          }
          throw insertErr;
        }
      }

      if (!newKey) {
        await client.query('ROLLBACK');
        reply.code(500).send({ error: 'Failed to generate unique API key after retries' });
        return;
      }

      // Revoke old key
      await client.query(
        'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1',
        [id],
      );

      // Fetch new key's metadata
      const newKeyRowRes = await client.query<{ id: string; created_at: Date }>(
        'SELECT id, created_at FROM api_keys WHERE id = $1',
        [newKeyId],
      );

      await client.query('COMMIT');

      reply.code(200).send({
        id: newKeyRowRes.rows[0]?.id || 'unknown',
        label: oldKey.label,
        tier: oldKey.tier,
        key: newKey,
        created_at: newKeyRowRes.rows[0]?.created_at || new Date().toISOString(),
      });
    } catch (err: any) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      logger.error({ error: err.message }, 'Failed to rotate API key');
      reply.code(500).send({ error: 'Internal server error' });
    } finally {
      if (client) {
        client.release();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Auth preHandler factory for API key management routes
// ---------------------------------------------------------------------------
function authPreHandler(auth: AuthService) {
  return async (request: any, reply: any) => {
    const apiKey = extractApiKey(request);
    if (!apiKey) {
      reply.code(401).send({ error: 'Missing or invalid Authorization header' });
      return reply; // returning stops further route handler execution
    }
    try {
      const authResult = await auth.authenticate(apiKey);
      (request.raw as any)._auth = {
        userId: authResult.userId,
        tier: authResult.tier,
        keyId: authResult.keyId,
      };
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
      return reply;
    }
  };
}
