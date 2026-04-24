import { DatabaseClient } from '../db/client.js';
import type { Embedder } from '../embedder/index.js';
import { ToolError } from '../errors/tool-error.js';
import { toSql } from 'pgvector';
import crypto from 'crypto';

export class RememberTool {
    constructor(
        private db: DatabaseClient,
        private embedder: Embedder,
    ) {}

    async remember(userId: string, tier: string, content: string, namespace: string = 'default'): Promise<string> {
        // Compute content hash (SHA-256)
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');
        // Atomic insert with dedupe and tier enforcement
        const memory = await this.db.withUserContext(userId, async (client) => {
            // 1. Check for duplicate
            const duplicateRes = await client.query<{ id: string }>(
                `SELECT id FROM memories WHERE user_id = $1 AND namespace = $2 AND content_hash = $3`,
                [userId, namespace, contentHash]
            );
            if (duplicateRes.rows.length > 0) {
                // Record dedupe event
                await client.query(
                    `INSERT INTO usage_events (user_id, event_type, metadata) VALUES ($1, 'remember_dedupe', '{}')`,
                    [userId]
                );
                return { id: duplicateRes.rows[0].id, deduped: true };
            }
            // 2. Tier enforcement (only for free tier)
            if (tier === 'free') {
                // Lock user row to serialize writes for this user
                await client.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
                // Count existing memories
                const countRes = await client.query<{ count: string }>(
                    `SELECT COUNT(*) FROM memories WHERE user_id = $1`,
                    [userId]
                );
                const count = parseInt(countRes.rows[0].count, 10);
                if (count >= 100) {
                    throw ToolError.limitExceeded();
                }
            }
            // 3. Generate embedding
            const embedding = await this.embedder.embed(content);
            // 4. Insert memory
            const insertRes = await client.query<{ id: string }>(
                `INSERT INTO memories (user_id, namespace, content, metadata, embedding, content_hash)
                 VALUES ($1, $2, $3, '{}', $4, $5)
                 RETURNING id`,
                [userId, namespace, content, toSql(embedding.vector), contentHash]
            );
            // 5. Record usage event
            await client.query(
                `INSERT INTO usage_events (user_id, event_type, metadata) VALUES ($1, 'remember', '{}')`,
                [userId]
            );
            return { id: insertRes.rows[0].id, deduped: false };
        });
        return memory.id;
    }
}
