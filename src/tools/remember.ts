import { DatabaseClient } from '../db/client.js';
import { Embedder } from '../embedder/index.js';
import { AuthService } from '../auth/index.js';
import { toSql } from 'pgvector';
import crypto from 'crypto';

export class RememberTool {
    constructor(
        private db: DatabaseClient,
        private embedder: Embedder,
        private auth: AuthService
    ) {}

    async remember(apiKey: string, content: string): Promise<string> {
        // Authenticate API key
        const { userId, tier } = await this.auth.authenticate(apiKey);
        // Tier enforcement
        if (tier === 'free') {
            const count = await this.db.withUserContext(userId, async (client) => {
                const res = await client.query<{ count: string }>(
                    `SELECT COUNT(*) FROM memories WHERE user_id = $1`,
                    [userId]
                );
                return parseInt(res.rows[0].count, 10);
            });
            if (count >= 100) {
                throw new Error('free tier limit exceeded: maximum 100 memories');
            }
        }
        // Generate embedding
        const embedding = await this.embedder.embed(content);
        // Compute content hash (SHA-256)
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');
        // Insert memory with user context
        const memory = await this.db.withUserContext(userId, async (client) => {
            const res = await client.query<{ id: string }>(
                `INSERT INTO memories (user_id, namespace, content, metadata, embedding, content_hash)
                 VALUES ($1, 'default', $2, '{}', $3, $4)
                 RETURNING id`,
                [userId, content, toSql(embedding.vector), contentHash]
            );
            // Record usage event
            await client.query(
                `INSERT INTO usage_events (user_id, event_type, metadata) VALUES ($1, 'remember', '{}')`,
                [userId]
            );
            return res.rows[0];
        });
        return memory.id;
    }
}