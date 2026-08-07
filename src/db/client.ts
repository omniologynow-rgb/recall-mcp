import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import pgvector from 'pgvector/pg';
import { toSql } from 'pgvector';


export interface MemoryRow {
    id: string;
    user_id: string;
    namespace: string;
    content: string;
    metadata: any;
    embedding: number[];
    content_hash: string;
    created_at: Date;
    updated_at: Date;
}

export interface MemoryInsert {
    user_id: string;
    namespace: string;
    content: string;
    metadata?: any;
    embedding: number[];
    content_hash: string;
}

export interface MemoryUpdate {
    content?: string;
    metadata?: any;
    namespace?: string;
    embedding?: number[];
    content_hash?: string;
}

export class DatabaseClient {
    private pool: Pool;

    constructor(connectionString: string) {
        this.pool = new Pool({
            connectionString,
            // SSL for production, but Supabase local doesn't need
            ssl: connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : false,
        });
    }

    static async registerVectorTypes(pool: Pool): Promise<void> {
        const client = await pool.connect();
        try {
            await pgvector.registerType(client);
        } finally {
            client.release();
        }
    }

    async registerVectorTypes(): Promise<void> {
        await DatabaseClient.registerVectorTypes(this.pool);
    }

    async query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
        const client = await this.pool.connect();
        try {
            return await client.query<T>(text, params);
        } finally {
            client.release();
        }
    }

    /**
     * Borrow a raw PoolClient for manual transaction management.
     * Caller MUST release the client via client.release() after use.
     */
    async getClient(): Promise<PoolClient> {
      return this.pool.connect();
    }

    async withUserContext<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
        // Validate userId is a UUID (format)
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
            throw new Error(`Invalid user ID format: ${userId}`);
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            // SET LOCAL does not support prepared statement parameters; interpolate safely.
            await client.query(`SET LOCAL app.current_user_id = '${userId}'`);
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Memory operations
    async insertMemory(memory: MemoryInsert): Promise<string> {
        const result = await this.withUserContext(memory.user_id, async (client) => {
            return client.query<{ id: string }>(
                `INSERT INTO memories (user_id, namespace, content, metadata, embedding, content_hash)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id`,
                [
                    memory.user_id,
                    memory.namespace,
                    memory.content,
                    memory.metadata ?? {},
                    toSql(memory.embedding),
                    memory.content_hash,
                ]
            );
        });
        return result.rows[0].id;
    }

    async findMemoryByContentHash(userId: string, namespace: string, contentHash: string): Promise<MemoryRow | null> {
        const result = await this.withUserContext(userId, async (client) => {
            return client.query<MemoryRow>(
                `SELECT * FROM memories
                 WHERE user_id = $1 AND namespace = $2 AND content_hash = $3
                 LIMIT 1`,
                [userId, namespace, contentHash]
            );
        });
        return result.rows[0] ?? null;
    }

    async searchMemories(
        userId: string,
        embedding: number[],
        namespace?: string,
        limit: number = 5,
        minSimilarity: number = 0.7
    ): Promise<Array<MemoryRow & { similarity: number }>> {
        const result = await this.withUserContext(userId, async (client) => {
            // cosine distance: embedding <=> $1 returns distance (0=identical, 2=opposite)
            // similarity = 1 - distance
            return client.query<MemoryRow & { similarity: number }>(
                `SELECT *, 1 - (embedding <=> $1) AS similarity
                 FROM memories
                 WHERE user_id = $2
                   AND ($3::text IS NULL OR namespace = $3)
                   AND 1 - (embedding <=> $1) >= $4
                 ORDER BY embedding <=> $1 ASC
                 LIMIT $5`,
                [toSql(embedding), userId, namespace ?? null, minSimilarity, limit]
            );
        });
        return result.rows;
    }

    async listMemories(
        userId: string,
        namespace?: string,
        limit: number = 50,
        cursor?: { created_at: Date; id: string }
    ): Promise<{ memories: MemoryRow[]; nextCursor: { created_at: Date; id: string } | null }> {
        const result = await this.withUserContext(userId, async (client) => {
            let whereClause = 'WHERE user_id = $1';
            const params: any[] = [userId];
            let paramIndex = 2;
            if (namespace) {
                whereClause += ` AND namespace = $${paramIndex}`;
                params.push(namespace);
                paramIndex++;
            }
            if (cursor) {
                whereClause += ` AND (created_at, id) < ($${paramIndex}, $${paramIndex + 1})`;
                params.push(cursor.created_at, cursor.id);
                paramIndex += 2;
            }
            const query = `
                SELECT * FROM memories
                ${whereClause}
                ORDER BY created_at DESC, id DESC
                LIMIT $${paramIndex}
            `;
            params.push(limit + 1); // fetch one extra to see if there's more
            return client.query<MemoryRow>(query, params);
        });
        const memories = result.rows.slice(0, limit);
        const nextRow = result.rows[limit];
        const nextCursor = nextRow
            ? { created_at: nextRow.created_at, id: nextRow.id }
            : null;
        return { memories, nextCursor };
    }

    async updateMemory(
        userId: string,
        memoryId: string,
        updates: MemoryUpdate
    ): Promise<{ updated_fields: string[] }> {
        const setClauses: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;
        if (updates.content !== undefined) {
            setClauses.push(`content = $${paramIndex}`);
            params.push(updates.content);
            paramIndex++;
        }
        if (updates.metadata !== undefined) {
            setClauses.push(`metadata = $${paramIndex}`);
            params.push(updates.metadata);
            paramIndex++;
        }
        if (updates.namespace !== undefined) {
            setClauses.push(`namespace = $${paramIndex}`);
            params.push(updates.namespace);
            paramIndex++;
        }
        if (updates.embedding !== undefined) {
            setClauses.push(`embedding = $${paramIndex}`);
            params.push(updates.embedding);
            paramIndex++;
        }
        if (updates.content_hash !== undefined) {
            setClauses.push(`content_hash = $${paramIndex}`);
            params.push(updates.content_hash);
            paramIndex++;
        }
        if (setClauses.length === 0) {
            return { updated_fields: [] };
        }
        params.push(userId, memoryId);
        const whereClause = `WHERE user_id = $${paramIndex} AND id = $${paramIndex + 1}`;
        paramIndex += 2;
        const query = `
            UPDATE memories
            SET ${setClauses.join(', ')}
            ${whereClause}
            RETURNING *
        `;
        const result = await this.withUserContext(userId, async (client) => {
            return client.query<MemoryRow>(query, params);
        });
        if (result.rowCount === 0) {
            throw new Error('Memory not found or access denied');
        }
        return { updated_fields: setClauses.map(c => c.split(' = ')[0]) };
    }

    async deleteMemory(userId: string, memoryId: string): Promise<void> {
        const result = await this.withUserContext(userId, async (client) => {
            return client.query(
                'DELETE FROM memories WHERE user_id = $1 AND id = $2',
                [userId, memoryId]
            );
        });
        if (result.rowCount === 0) {
            throw new Error('Memory not found or access denied');
        }
    }

    async deleteMemoriesByQuery(
        userId: string,
        namespace: string,
        embedding: number[],
        limit: number
    ): Promise<string[]> {
        const result = await this.withUserContext(userId, async (client) => {
            // Find top matching memories
            return client.query<{ id: string }>(
                `SELECT id FROM memories
                 WHERE user_id = $1 AND namespace = $2
                 ORDER BY embedding <=> $3 ASC
                 LIMIT $4`,
                [userId, namespace, embedding, limit]
            );
        });
        const ids = result.rows.map((row: any) => row.id);
        if (ids.length === 0) {
            return [];
        }
        await this.withUserContext(userId, async (client) => {
            await client.query(
                'DELETE FROM memories WHERE user_id = $1 AND id = ANY($2)',
                [userId, ids]
            );
        });
        return ids;
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}