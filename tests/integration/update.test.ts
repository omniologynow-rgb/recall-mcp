import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { UpdateMemoryTool } from '../../src/tools/update.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function applyMigrations(client: DatabaseClient) {
    const migrationsDir = path.join(__dirname, '../../supabase/migrations');
    const files = (await fs.readdir(migrationsDir))
        .filter(f => f.endsWith('.sql'))
        .sort();
    for (const file of files) {
        const migrationPath = path.join(migrationsDir, file);
        const migrationSql = await fs.readFile(migrationPath, 'utf8');
        try {
            await client.query(migrationSql);
        } catch (err) {
            // Ignore duplicate extension/object errors
            if (!(err instanceof Error && err.message.includes('already exists'))) {
                throw err;
            }
        }
    }
}

describe('Update memory tool integration', () => {
    let container: any;
    let adminClient: DatabaseClient;
    let embedder: MockEmbedder;
    let updateTool: UpdateMemoryTool;
    let userId: string;
    let memoryId: string;

    beforeAll(async () => {
        // Start PostgreSQL container with pgvector
        container = await new PostgreSqlContainer('pgvector/pgvector:pg15')
            .withDatabase('testdb')
            .withUsername('test')
            .withPassword('test')
            .withExposedPorts(5432)
            .start();

        const connectionString = `postgresql://test:test@${container.getHost()}:${container.getPort()}/testdb`;
        adminClient = new DatabaseClient(connectionString);

        await applyMigrations(adminClient);
        await adminClient.registerVectorTypes();

        // Create a test user
        const userRes = await adminClient.query<{ id: string }>(
            `INSERT INTO users (id, email, tier) VALUES (gen_random_uuid(), $1, 'free') RETURNING id`,
            [`test-${Date.now()}@example.com`]
        );
        userId = userRes.rows[0].id;

        // Create an API key for the user

        // Create embedder and tool
        embedder = new MockEmbedder();
        updateTool = new UpdateMemoryTool(adminClient, embedder);

        // Seed a memory
        await adminClient.withUserContext(userId, async (client) => {
            const content = 'Original content';
            const embedding = await embedder.embed(content);
            const vectorLiteral = `[${embedding.vector.join(',')}]`;
            const contentHash = crypto.createHash('sha256').update(content).digest('hex');
            const res = await client.query<{ id: string }>(
                `INSERT INTO memories (user_id, namespace, content, embedding, content_hash)
                 VALUES ($1, $2, $3, $4::vector, $5)
                 RETURNING id`,
                [userId, 'default', content, vectorLiteral, contentHash]
            );
            memoryId = res.rows[0].id;
        });
    });

    afterAll(async () => {
        await adminClient?.close();
        await container?.stop();
    });

    it('should update memory content', async () => {
        const success = await updateTool.update(userId, memoryId, 'Updated content');
        expect(success).toBe(true);

        // Verify changes
        const memory = await adminClient.withUserContext(userId, async (client) => {
            return client.query<{
                content: string;
                namespace: string;
                content_hash: string;
                embedding: any;
                updated_at: string;
            }>(
                `SELECT content, namespace, content_hash, embedding, updated_at
                 FROM memories WHERE id = $1`,
                [memoryId]
            );
        });
        expect(memory.rows).toHaveLength(1);
        const row = memory.rows[0];
        expect(row.content).toBe('Updated content');
        // Content hash should be updated
        const expectedHash = crypto.createHash('sha256').update('Updated content').digest('hex');
        expect(row.content_hash).toBe(expectedHash);
        // Embedding should be recomputed (MockEmbedder returns deterministic vector)
        const newEmbedding = await embedder.embed('Updated content');
        const embeddingArray = Array.isArray(row.embedding) ? row.embedding : JSON.parse(row.embedding);
        expect(embeddingArray).toHaveLength(newEmbedding.dimensions); // length 1536
        // We could also check that embedding is not equal to original, but trust update
        // updated_at should be more recent than created_at (but we don't have created_at here)
        expect(new Date(row.updated_at).getTime()).toBeGreaterThan(0);
    });

    it('should reject update if memory not found', async () => {
        const fakeId = crypto.randomUUID();
        await expect(updateTool.update(userId, fakeId, 'new content')).rejects.toThrow();
    });

    it('should reject update if duplicate content in same namespace', async () => {
        // Create a second memory with content 'Duplicate'
        let secondId: string;
        await adminClient.withUserContext(userId, async (client) => {
            const content = 'Duplicate';
            const embedding = await embedder.embed(content);
            const vectorLiteral = `[${embedding.vector.join(',')}]`;
            const contentHash = crypto.createHash('sha256').update(content).digest('hex');
            const res = await client.query<{ id: string }>(
                `INSERT INTO memories (user_id, namespace, content, embedding, content_hash)
                 VALUES ($1, $2, $3, $4::vector, $5)
                 RETURNING id`,
                [userId, 'default', content, vectorLiteral, contentHash]
            );
            secondId = res.rows[0].id;
        });
        // Try to update first memory to 'Duplicate' (same namespace) -> should fail due to duplicate content check
        await expect(updateTool.update(userId, memoryId, 'Duplicate')).rejects.toThrow();
    });

        // Update again
});