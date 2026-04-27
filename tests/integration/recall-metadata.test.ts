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
            if (!(err instanceof Error && err.message.includes('already exists'))) {
                throw err;
            }
        }
    }
}

describe('Recall with metadata_filter integration (R6)', () => {
    let container: Awaited<ReturnType<typeof PostgreSqlContainer.prototype.start>>;
    let adminClient: DatabaseClient;
    let embedder: MockEmbedder;
    let recallTool: RecallTool;
    let userId: string;

    beforeAll(async () => {
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

        const userRes = await adminClient.query<{ id: string }>(
            `INSERT INTO users (id, email, tier) VALUES (gen_random_uuid(), $1, 'free') RETURNING id`,
            [`recall-meta-${Date.now()}@example.com`]
        );
        userId = userRes.rows[0].id;

        embedder = new MockEmbedder();
        recallTool = new RecallTool(adminClient, embedder);

        // Seed memories with metadata across namespaces
        await adminClient.withUserContext(userId, async (client) => {
            const memories = [
                {
                    content: 'The quick brown fox jumps over the lazy dog',
                    namespace: 'general',
                    metadata: { source: 'story', year: 1880, public: true, lang: 'en' },
                },
                {
                    content: 'Python is great for data science',
                    namespace: 'tech',
                    metadata: { source: 'blog', year: 2024, public: true, lang: 'en' },
                },
                {
                    content: 'Machine learning models require large datasets',
                    namespace: 'tech',
                    metadata: { source: 'paper', year: 2023, public: true, lang: 'en' },
                },
                {
                    content: 'The mitochondria is the powerhouse of the cell',
                    namespace: 'science',
                    metadata: { source: 'textbook', year: 2020, public: false, lang: 'en' },
                },
                {
                    content: 'La luna es brillante esta noche',
                    namespace: 'general',
                    metadata: { source: 'journal', year: 2025, public: true, lang: 'es' },
                },
                {
                    content: 'Le chat dort sur le canapé',
                    namespace: 'general',
                    metadata: { source: 'journal', year: 2025, public: true, lang: 'fr' },
                },
            ];
            for (const mem of memories) {
                const embedding = Array.from({ length: 1536 }, () => Math.random() * 0.1);
                const vectorLiteral = `[${embedding.join(',')}]`;
                const contentHash = crypto.createHash('sha256').update(mem.content).digest('hex');
                const metaJson = JSON.stringify(mem.metadata);
                await client.query(
                    `INSERT INTO memories (user_id, namespace, content, embedding, content_hash, metadata)
                     VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb)`,
                    [userId, mem.namespace, mem.content, vectorLiteral, contentHash, metaJson]
                );
            }
        });
    });

    afterAll(async () => {
        await adminClient?.close();
        await container?.stop();
    });

    // ─── Matched subset─────────────────────────────────────────────────────

    it('should return only memories matching a single metadata filter key', async () => {
        // Filter by source: 'journal' — 2 memories (La luna, Le chat)
        const results = await recallTool.recall(userId, 'language', 'general', 10, 0.0, { source: 'journal' });
        expect(results.length).toBeGreaterThanOrEqual(2);
        results.forEach(r => {
            expect(r.metadata).toHaveProperty('source', 'journal');
        });
    });

    it('should return only memories matching numeric metadata', async () => {
        // Filter by year: 2024 — 1 memory (Python blog)
        const results = await recallTool.recall(userId, 'Python', 'tech', 10, 0.0, { year: 2024 });
        expect(results.length).toBe(1);
        expect(results[0].metadata).toHaveProperty('year', 2024);
    });

    it('should return only memories matching boolean metadata', async () => {
        // Filter by public: false — 1 memory (mitochondria)
        const results = await recallTool.recall(userId, 'cell', 'science', 10, 0.0, { public: false });
        expect(results.length).toBe(1);
        expect(results[0].metadata).toHaveProperty('public', false);
    });

    // ─── Multi-key AND ─────────────────────────────────────────────────────

    it('should apply multi-key AND filter', async () => {
        // Filter by source: 'journal' AND year: 2025 — 2 memories (La luna, Le chat)
        const results = await recallTool.recall(userId, 'language', 'general', 10, 0.0, { source: 'journal', year: 2025 });
        expect(results.length).toBe(2);
        results.forEach(r => {
            expect(r.metadata).toHaveProperty('source', 'journal');
            expect(r.metadata).toHaveProperty('year', 2025);
        });
    });

    it('should return zero matches for non-existent metadata value', async () => {
        // Filter by source: 'nonexistent' — no matches
        const results = await recallTool.recall(userId, 'fox', 'general', 10, 0.0, { source: 'nonexistent' });
        expect(results).toHaveLength(0);
    });

    it('should return zero matches for mismatched multi-key AND', async () => {
        // Filter by source: 'story' AND year: 2024 — no match (story is 1880, 2024 is blog)
        const results = await recallTool.recall(userId, 'fox', 'general', 10, 0.0, { source: 'story', year: 2024 });
        expect(results).toHaveLength(0);
    });

    // ─── Namespace + filter ───────────────────────────────────────────────

    it('should combine namespace filter with metadata filter', async () => {
        // 'tech' namespace + year: 2023 — 1 memory (ML paper)
        const results = await recallTool.recall(userId, 'machine learning', 'tech', 10, 0.0, { year: 2023 });
        expect(results.length).toBe(1);
        results.forEach(r => {
            expect(r.namespace).toBe('tech');
            expect(r.metadata).toHaveProperty('year', 2023);
        });
    });

    // ─── Threshold + filter ───────────────────────────────────────────────

    it('should combine threshold with metadata filter', async () => {
        // Zero matches when threshold is too high, even with matching filter
        const results = await recallTool.recall(userId, 'fox', 'general', 10, 0.99, { source: 'journal' });
        expect(results).toHaveLength(0);
    });

    // ─── Empty filter no-op ────────────────────────────────────────────────

    it('should treat empty metadata_filter as no-op (returns all matching)', async () => {
        // Empty filter should not affect results
        const withoutFilter = await recallTool.recall(userId, 'fox', 'general', 10, 0.0);
        const withEmptyFilter = await recallTool.recall(userId, 'fox', 'general', 10, 0.0, {});
        expect(withEmptyFilter.length).toBe(withoutFilter.length);
    });

    // ─── RLS isolation still holds ─────────────────────────────────────────

    it('should not leak metadata-filtered results across users', async () => {
        // Create a second user with different data
        const user2Res = await adminClient.query<{ id: string }>(
            `INSERT INTO users (id, email, tier) VALUES (gen_random_uuid(), $1, 'free') RETURNING id`,
            [`other-${Date.now()}@example.com`]
        );
        const userId2 = user2Res.rows[0].id;

        await adminClient.withUserContext(userId2, async (client) => {
            const embedding = Array.from({ length: 1536 }, () => Math.random() * 0.1);
            const vectorLiteral = `[${embedding.join(',')}]`;
            await client.query(
                `INSERT INTO memories (user_id, namespace, content, embedding, content_hash, metadata)
                 VALUES ($1, 'secret', 'Secret data', $2::vector, $3, '{"source":"hidden"}'::jsonb)`,
                [userId2, vectorLiteral, crypto.createHash('sha256').update('Secret data').digest('hex')]
            );
        });

        // User 1 should not see user 2's secret data
        const results = await recallTool.recall(userId, 'Secret', 'secret', 10, 0.0, { source: 'hidden' });
        expect(results).toHaveLength(0);
    });
});
