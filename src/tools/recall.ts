import { DatabaseClient } from '../db/client.js';
import type { Embedder } from '../embedder/index.js';
import { toSql } from 'pgvector';

export interface RecallResult {
    id: string;
    content: string;
    similarity: number;
    metadata: Record<string, unknown>;
    namespace: string;
    created_at: string;
}

export class RecallTool {
    constructor(
        private db: DatabaseClient,
        private embedder: Embedder,
    ) {}

    async recall(
        userId: string,
        query: string,
        namespace: string = 'default',
        limit: number = 10,
        minSimilarity: number = 0.7,
        metadataFilter?: Record<string, unknown>,
    ): Promise<RecallResult[]> {
        // Generate embedding for the query
        const embedding = await this.embedder.embed(query);
        const embeddingSql = toSql(embedding.vector);

        const results = await this.db.withUserContext(userId, async (client) => {
            // Build metadata filter clause (jsonb containment: metadata @> $filter::jsonb)
            // Empty / undefined filter → no SQL added
            const metaFilterJson = (metadataFilter && Object.keys(metadataFilter).length > 0)
                ? JSON.stringify(metadataFilter)
                : null;
            const metaClause = metaFilterJson
                ? ` AND metadata @> $6::jsonb`
                : '';

            const params: any[] = [embeddingSql, userId, namespace, minSimilarity, limit];
            if (metaFilterJson) {
                params.push(metaFilterJson);
            }

            const res = await client.query<{
                id: string;
                content: string;
                similarity: number;
                metadata: Record<string, unknown>;
                namespace: string;
                created_at: string;
            }>(
                `SELECT 
                    id,
                    content,
                    1 - (embedding <=> $1::vector) AS similarity,
                    metadata,
                    namespace,
                    created_at
                 FROM memories
                 WHERE user_id = $2
                   AND namespace = $3
                   AND 1 - (embedding <=> $1::vector) >= $4
                   ${metaClause}
                 ORDER BY similarity DESC
                 LIMIT $5`,
                params
            );
            // Record usage event
            await client.query(
                `INSERT INTO usage_events (user_id, event_type, metadata) VALUES ($1, 'recall', '{}')`,
                [userId]
            );
            return res.rows;
        });
        return results;
    }

    /**
     * Format a recall result into a prompt-injection-resistant <memory> tag.
     *
     * The raw content is placed inside a <content> sub-tag so that any
     * </memory> or <content> present in the stored content cannot break out
     * of the wrapper. Any literal < or > inside the content is HTML-escaped
     * to &lt; and &gt; (safe inside the <content> block since XML parsers
     * treat that as text content, and string-based checks can match the
     * literal entity).
     */
    static formatMemoryTag(memory: RecallResult): string {
        const safeContent = memory.content
            .replace(/&/g, '&amp;')   // & first to avoid double-encoding
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return [
            `<memory id="${memory.id}" namespace="${memory.namespace}" created="${memory.created_at}">`,
            `<content>${safeContent}</content>`,
            `</memory>`,
        ].join('\n');
    }

    /**
     * Format an array of recall results into a combined string of <memory> tags.
     */
    static formatBatchForRecall(results: RecallResult[]): string {
        return results.map(r => RecallTool.formatMemoryTag(r)).join('\n\n');
    }
}
