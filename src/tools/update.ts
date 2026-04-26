import { DatabaseClient } from '../db/client.js';
import type { Embedder } from '../embedder/index.js';
import { ToolError } from '../errors/tool-error.js';
import { toSql } from 'pgvector';
import { normalizeContent, computeContentHash } from '../normalize.js';

export class UpdateMemoryTool {
    constructor(
        private db: DatabaseClient,
        private embedder: Embedder,
    ) {}

    async update(
        userId: string,
        memoryId: string,
        content?: string,
        metadata?: Record<string, unknown>,
    ): Promise<boolean> {
        const updated = await this.db.withUserContext(userId, async (client) => {
            // Ensure memory exists and belongs to user
            const existingRes = await client.query<{ id: string; namespace: string }>(
                `SELECT id, namespace FROM memories WHERE id = $1 AND user_id = $2`,
                [memoryId, userId]
            );
            if (existingRes.rows.length === 0) {
                throw ToolError.notFound('Memory not found');
            }
            const existingNamespace = existingRes.rows[0].namespace;

            if (content) {
                const normalized = normalizeContent(content);
                const embedding = await this.embedder.embed(normalized);
                const embeddingSql = toSql(embedding.vector);
                const contentHash = computeContentHash(content);

                // Check for duplicate content in the same namespace (excluding this memory)
                const duplicateRes = await client.query<{ id: string }>(
                    `SELECT id FROM memories
                     WHERE user_id = $1 AND namespace = $2 AND content_hash = $3 AND id != $4`,
                    [userId, existingNamespace, contentHash, memoryId]
                );
                if (duplicateRes.rows.length > 0) {
                    throw ToolError.validationError('Duplicate content in same namespace');
                }

                const updateRes = await client.query<{ id: string }>(
                    `UPDATE memories
                     SET content = $1, embedding = $2::vector, content_hash = $3, updated_at = now()
                     WHERE id = $4 AND user_id = $5
                     RETURNING id`,
                    [normalized, embeddingSql, contentHash, memoryId, userId]
                );
                if (updateRes.rows.length === 0) {
                    throw ToolError.internalError('Update failed');
                }
            }

            if (metadata) {
                const updateRes = await client.query<{ id: string }>(
                    `UPDATE memories
                     SET metadata = $1::jsonb, updated_at = now()
                     WHERE id = $2 AND user_id = $3
                     RETURNING id`,
                    [JSON.stringify(metadata), memoryId, userId]
                );
                if (updateRes.rows.length === 0) {
                    throw ToolError.internalError('Update failed');
                }
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
