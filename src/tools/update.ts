import { DatabaseClient } from '../db/client.js';
import type { Embedder } from '../embedder/index.js';
import { AuthService } from '../auth/index.js';
import { ToolError } from '../errors/tool-error.js';
import { toSql } from 'pgvector';
import crypto from 'crypto';

export class UpdateMemoryTool {
    constructor(
        private db: DatabaseClient,
        private embedder: Embedder,
        private auth: AuthService
    ) {}

    async update(
        apiKey: string,
        memoryId: string,
        content: string,
        namespace: string = 'default'
    ): Promise<boolean> {
        // Authenticate API key
        const { userId } = await this.auth.authenticate(apiKey);
        // Compute new embedding and hash
        const embedding = await this.embedder.embed(content);
        const embeddingSql = toSql(embedding.vector);
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');

        const updated = await this.db.withUserContext(userId, async (client) => {
            // Ensure memory exists and belongs to user
            const existingRes = await client.query<{ id: string }>(
                `SELECT id FROM memories WHERE id = $1 AND user_id = $2`,
                [memoryId, userId]
            );
            if (existingRes.rows.length === 0) {
                throw ToolError.notFound('Memory not found');
            }
            // Check for duplicate content (excluding this memory)
            const duplicateRes = await client.query<{ id: string }>(
                `SELECT id FROM memories 
                 WHERE user_id = $1 AND namespace = $2 AND content_hash = $3 AND id != $4`,
                [userId, namespace, contentHash, memoryId]
            );
            if (duplicateRes.rows.length > 0) {
                throw ToolError.validationError('Duplicate content in same namespace');
            }
            // Update memory
            const updateRes = await client.query<{ id: string }>(
                `UPDATE memories 
                 SET content = $1, namespace = $2, embedding = $3::vector, 
                     content_hash = $4, updated_at = now()
                 WHERE id = $5 AND user_id = $6
                 RETURNING id`,
                [content, namespace, embeddingSql, contentHash, memoryId, userId]
            );
            if (updateRes.rows.length === 0) {
                // Should not happen given earlier check
                throw ToolError.internalError('Update failed');
            }
            // Record usage event
            await client.query(
                `INSERT INTO usage_events (user_id, event_type, metadata) VALUES ($1, 'update', '{}')`,
                [userId]
            );
            return true;
        });
        return updated;
    }
}