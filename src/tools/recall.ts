import { DatabaseClient } from '../db/client.js';
import { Embedder } from '../embedder/index.js';
import { AuthService } from '../auth/index.js';
import { ToolError } from '../errors/tool-error.js';
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
        private auth: AuthService
    ) {}

    async recall(
        apiKey: string,
        query: string,
        namespace: string = 'default',
        limit: number = 10,
        minSimilarity: number = 0.7
    ): Promise<RecallResult[]> {
        // Authenticate API key
        const { userId } = await this.auth.authenticate(apiKey);
        // Generate embedding for the query
        const embedding = await this.embedder.embed(query);
        const embeddingSql = toSql(embedding.vector);

        const results = await this.db.withUserContext(userId, async (client) => {
            // Cosine similarity: 1 - (embedding <=> memories.embedding)
            // Filter by namespace (or all namespaces if default? We'll use exact match for now)
            // Ensure similarity >= minSimilarity
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
                   AND ($3 = 'default' OR namespace = $3)
                   AND 1 - (embedding <=> $1::vector) >= $4
                 ORDER BY similarity DESC
                 LIMIT $5`,
                [embeddingSql, userId, namespace, minSimilarity, limit]
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
}