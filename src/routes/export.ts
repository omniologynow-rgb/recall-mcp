/**
 * Data export — GET /api/export
 *
 * "Your data leaves with you, anytime." Returns EVERYTHING the account owns —
 * every memory in every namespace (personas live in namespaces too, so they
 * are included) — as a single JSON document. No embeddings (they are
 * derivable from content and provider-specific); content, metadata, and
 * timestamps are the portable truth.
 *
 * Auth: same as /mcp — Bearer key or ?key=. Rate-limited with the caller's
 * normal per-key bucket (one export = one request regardless of size).
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '../db/client.js';
import type { AuthService } from '../auth/index.js';
import type { InMemoryRateLimiter } from '../ratelimit/in-memory.js';
import type pino from 'pino';
import { extractApiKey } from '../auth/extract.js';

const EXPORT_PAGE_SIZE = 500;

export function registerExportRoute(
  fastify: FastifyInstance,
  db: DatabaseClient,
  auth: AuthService,
  rateLimiter: InMemoryRateLimiter,
  logger: pino.Logger,
): void {
  fastify.get('/api/export', async (request, reply) => {
    const apiKey = extractApiKey(request as any);
    if (!apiKey) {
      reply.code(401).send({ error: 'Missing or invalid Authorization header' });
      return;
    }

    let authResult;
    try {
      authResult = await auth.authenticate(apiKey);
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const { allowed, retryAfter } = await rateLimiter.check(authResult.keyId, authResult.tier || 'free');
    if (!allowed) {
      reply.header('Retry-After', String(retryAfter));
      reply.code(429).send({ error: 'Too Many Requests', retry_after: retryAfter });
      return;
    }

    try {
      const userRes = await db.query<{ email: string; tier: string; created_at: Date }>(
        'SELECT email, tier, created_at FROM users WHERE id = $1',
        [authResult.userId],
      );
      const account = userRes.rows[0];

      // Page through all namespaces (listMemories without a namespace filter
      // returns everything the RLS context can see — i.e., this user's rows).
      const memories: Array<{
        id: string;
        namespace: string;
        content: string;
        metadata: unknown;
        created_at: Date;
        updated_at: Date;
      }> = [];
      let cursor: { created_at: Date; id: string } | undefined = undefined;
      do {
        const page = await db.listMemories(authResult.userId, undefined, EXPORT_PAGE_SIZE, cursor);
        for (const row of page.memories) {
          memories.push({
            id: row.id,
            namespace: row.namespace,
            content: row.content,
            metadata: row.metadata,
            created_at: row.created_at,
            updated_at: row.updated_at,
          });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      const namespaces = [...new Set(memories.map((m) => m.namespace))].sort();

      const stamp = new Date();
      reply
        .header(
          'Content-Disposition',
          `attachment; filename="recall-export-${stamp.toISOString().slice(0, 10)}.json"`,
        )
        .code(200)
        .send({
          format: 'recall.export',
          format_version: 1,
          exported_at: stamp,
          account: {
            user_id: authResult.userId,
            email: account?.email ?? null,
            tier: account?.tier ?? authResult.tier,
            created_at: account?.created_at ?? null,
          },
          memory_count: memories.length,
          namespaces,
          memories,
        });
    } catch (err: any) {
      logger.error({ error: err.message }, 'export_failed');
      reply.code(500).send({ error: 'Internal server error' });
    }
  });
}
