import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { RecallTool } from '../../src/tools/recall.js';
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
            if (!(err instanceof Error && err.message.includes('already exists'))) {
                throw err;
            }
        }
    }
}

describe('Cross-user isolation (R3b)', () => {
    let container: Awaited<ReturnType<typeof PostgreSqlContainer.prototype.start>>;
    let adminClient: DatabaseClient;
    let embedder: MockEmbedder;
    let recallTool: RecallTool;
    let userIdA: string;
    let userIdB: string;
    let memoryIdsA: string[];
    let memoryIdsB: string[];

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

        embedder = new MockEmbedder();
        recallTool = new RecallTool(adminClient, embedder);

        userIdA = crypto.randomUUID();
        userIdB = crypto.randomUUID();
        memoryIdsA = [];
        memoryIdsB = [];

        const emailSuffix = `test-${Date.now()}`;
        // Create both users
        await adminClient.withUserContext(userIdA, async (client) => {
            await client.query(
                `INSERT INTO users (id, email, tier) VALUES ($1, $2, 'free') ON CONFLICT (id) DO NOTHING`,
                [userIdA, `${emailSuffix}-a@example.com`]
            );
        });
        await adminClient.withUserContext(userIdB, async (client) => {
            await client.query(
                `INSERT INTO users (id, email, tier) VALUES ($1, $2, 'free') ON CONFLICT (id) DO NOTHING`,
                [userIdB, `${emailSuffix}-b@example.com`]
            );
        });

        // Seed 3 memories for user A — animal/fox domain
        const aContents = [
            'The quick brown fox jumps over the lazy dog',
            'Foxes are clever nocturnal animals that hunt small prey',
            'In the forest, a red fox darted across the path',
        ];
        for (const content of aContents) {
            const id = crypto.randomUUID();
            const embedding = await embedder.embed(content);
            const vectorLiteral = `[${embedding.vector.join(',')}]`;
            const contentHash = crypto.createHash('sha256').update(content).digest('hex');
            await adminClient.withUserContext(userIdA, async (client) => {
                await client.query(
                    `INSERT INTO memories (id, user_id, namespace, content, embedding, content_hash)
                     VALUES ($1, $2, 'default', $3, $4::vector, $5)`,
                    [id, userIdA, content, vectorLiteral, contentHash]
                );
            });
            memoryIdsA.push(id);
        }

        // Seed 3 memories for user B — ALSO animal/fox domain (different content, same semantic domain)
        const bContents = [
            'The arctic fox has thick white fur for winter camouflage',
            'Foxes communicate using high-pitched barks and tail signals',
            'A family of foxes lived in the den under the old oak tree',
        ];
        for (const content of bContents) {
            const id = crypto.randomUUID();
            const embedding = await embedder.embed(content);
            const vectorLiteral = `[${embedding.vector.join(',')}]`;
            const contentHash = crypto.createHash('sha256').update(content).digest('hex');
            await adminClient.withUserContext(userIdB, async (client) => {
                await client.query(
                    `INSERT INTO memories (id, user_id, namespace, content, embedding, content_hash)
                     VALUES ($1, $2, 'default', $3, $4::vector, $5)`,
                    [id, userIdB, content, vectorLiteral, contentHash]
                );
            });
            memoryIdsB.push(id);
        }
    });

    afterAll(async () => {
        await adminClient?.close();
        await container?.stop();
    });

    it('should NOT leak user B memories when recall is called as user A', async () => {
        const results = await recallTool.recall(userIdA, 'fox', 'default', 50, 0.0);

        const resultIds = results.map(r => r.id);
        for (const id of resultIds) {
            expect(memoryIdsA).toContain(id);
        }

        for (const bId of memoryIdsB) {
            expect(resultIds).not.toContain(bId);
        }

        expect(resultIds.length).toBe(3);
    });

    it('should NOT leak user A memories when recall is called as user B', async () => {
        const results = await recallTool.recall(userIdB, 'fox', 'default', 50, 0.0);

        const resultIds = results.map(r => r.id);
        for (const id of resultIds) {
            expect(memoryIdsB).toContain(id);
        }

        for (const aId of memoryIdsA) {
            expect(resultIds).not.toContain(aId);
        }

        expect(resultIds.length).toBe(3);
    });

    it('should return empty results for a user with no memories', async () => {
        const userIdFresh = crypto.randomUUID();
        await adminClient.withUserContext(userIdFresh, async (client) => {
            await client.query(
                `INSERT INTO users (id, email, tier) VALUES ($1, $2, 'free') ON CONFLICT (id) DO NOTHING`,
                [userIdFresh, `fresh-${Date.now()}@example.com`]
            );
        });
        const results = await recallTool.recall(userIdFresh, 'anything', 'default', 10, 0.0);
        expect(results).toHaveLength(0);
    });
});
