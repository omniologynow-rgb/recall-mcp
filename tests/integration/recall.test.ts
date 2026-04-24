import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { RecallTool } from '../../src/tools/recall.js';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

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

describe('Recall tool integration', () => {
    let container: any;
    let adminClient: DatabaseClient;
    let embedder: MockEmbedder;
    let recallTool: RecallTool;
    let userId: string;

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
        recallTool = new RecallTool(adminClient, embedder);

        // Seed a few memories with different content
        // Use adminClient.withUserContext to insert as the user
        await adminClient.withUserContext(userId, async (client) => {
            // Insert three memories with distinct content
            const memories = [
                { content: 'The quick brown fox jumps over the lazy dog', namespace: 'animals' },
                { content: 'Artificial intelligence is transforming the world', namespace: 'tech' },
                { content: 'The weather today is sunny and warm', namespace: 'general' },
            ];
            for (const mem of memories) {
                // MockEmbedder returns same vector for all content; we need to differentiate
                // We'll insert directly with a dummy embedding, using pgvector's toSql format
                const embedding = Array.from({ length: 1536 }, () => Math.random() * 0.1); // random vector
                // Convert to pgvector literal
                const vectorLiteral = `[${embedding.join(',')}]`;
                const contentHash = crypto.createHash('sha256').update(mem.content).digest('hex');
                await client.query(
                    `INSERT INTO memories (user_id, namespace, content, embedding, content_hash)
                     VALUES ($1, $2, $3, $4::vector, $5)`,
                    [userId, mem.namespace, mem.content, vectorLiteral, contentHash]
                );
            }
        });
    });

    afterAll(async () => {
        await adminClient?.close();
        await container?.stop();
    });

    it('should return similar memories for a query', async () => {
        // MockEmbedder returns deterministic embedding based on text hash
        // Similarity between query 'fox' and seeded memories may be high
        const results = await recallTool.recall(userId, 'fox', 'general');
        expect(results).toBeInstanceOf(Array);
        // Should have at least one result (similarity >= 0.7)
        expect(results.length).toBeGreaterThan(0);
        // Each result should have required fields
        results.forEach(r => {
            expect(r).toHaveProperty('id');
            expect(r).toHaveProperty('content');
            expect(r).toHaveProperty('similarity');
            expect(r.similarity).toBeGreaterThanOrEqual(0.7);
            expect(r).toHaveProperty('namespace');
            expect(r.namespace).toBe('general');
            expect(r).toHaveProperty('created_at');
        });
    });

    it('should filter by minSimilarity', async () => {
        // Set minSimilarity high enough to exclude all memories
        const results = await recallTool.recall(userId, 'fox', 'general', 10, 0.99);
        expect(results).toHaveLength(0);
    });

    it('should respect namespace filter', async () => {
        // Search in 'animals' namespace
        const results = await recallTool.recall(userId, 'fox', 'animals');
        expect(results).toBeInstanceOf(Array);
        // All returned memories should belong to 'animals' namespace
        results.forEach(r => {
            expect(r.namespace).toBe('animals');
        });
    });

    it('should enforce limit parameter', async () => {
        // Limit 1
        const results = await recallTool.recall(userId, 'fox', 'general', 1);
        expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should emit usage event on success', async () => {
        await recallTool.recall(userId, 'test query');
        const events = await adminClient.withUserContext(userId, async (client) => {
            return client.query<{ event_type: string }>(
                `SELECT event_type FROM usage_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [userId]
            );
        });
        expect(events.rows).toHaveLength(1);
        expect(events.rows[0].event_type).toBe('recall');
    });
});