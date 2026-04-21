import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
import { AuthService } from '../../src/auth/index.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { ForgetTool } from '../../src/tools/forget.js';
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

describe('Forget tool integration', () => {
    let container: any;
    let adminClient: DatabaseClient;
    let authService: AuthService;
    let embedder: MockEmbedder;
    let forgetTool: ForgetTool;
    let userId: string;
    let apiKey: string;
    let memoryId: string;
    let otherUserId: string;
    let otherMemoryId: string;

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

        // Create two test users
        const userRes = await adminClient.query<{ id: string }>(
            `INSERT INTO users (id, email, tier) VALUES (gen_random_uuid(), $1, 'free') RETURNING id`,
            [`test-${Date.now()}@example.com`]
        );
        userId = userRes.rows[0].id;
        const otherUserRes = await adminClient.query<{ id: string }>(
            `INSERT INTO users (id, email, tier) VALUES (gen_random_uuid(), $1, 'free') RETURNING id`,
            [`other-${Date.now()}@example.com`]
        );
        otherUserId = otherUserRes.rows[0].id;

        // Create API keys for both users (we only need one)
        authService = new AuthService(adminClient);
        const { key } = await authService.generateApiKey(userId, 'test key');
        apiKey = key;

        // Create embedder and tool
        embedder = new MockEmbedder();
        forgetTool = new ForgetTool(adminClient, authService);

        // Seed a memory for the primary user
        await adminClient.withUserContext(userId, async (client) => {
            const content = 'Memory to forget';
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
        // Seed a memory for the other user (should not be deletable by primary user)
        await adminClient.withUserContext(otherUserId, async (client) => {
            const content = 'Other user memory';
            const embedding = await embedder.embed(content);
            const vectorLiteral = `[${embedding.vector.join(',')}]`;
            const contentHash = crypto.createHash('sha256').update(content).digest('hex');
            const res = await client.query<{ id: string }>(
                `INSERT INTO memories (user_id, namespace, content, embedding, content_hash)
                 VALUES ($1, $2, $3, $4::vector, $5)
                 RETURNING id`,
                [otherUserId, 'default', content, vectorLiteral, contentHash]
            );
            otherMemoryId = res.rows[0].id;
        });
    });

    afterAll(async () => {
        await adminClient?.close();
        await container?.stop();
    });

    it('should delete memory owned by user', async () => {
        const success = await forgetTool.forget(apiKey, memoryId);
        expect(success).toBe(true);

        // Verify memory is gone
        const memory = await adminClient.withUserContext(userId, async (client) => {
            return client.query<{ id: string }>(
                `SELECT id FROM memories WHERE id = $1`,
                [memoryId]
            );
        });
        expect(memory.rows).toHaveLength(0);
    });

    it('should reject delete if memory not found', async () => {
        const fakeId = crypto.randomUUID();
        await expect(forgetTool.forget(apiKey, fakeId)).rejects.toThrow();
    });

    it('should reject delete if memory belongs to other user', async () => {
        // Attempt to delete other user's memory using primary user's API key
        await expect(forgetTool.forget(apiKey, otherMemoryId)).rejects.toThrow();
        // Verify other user's memory still exists
        const memory = await adminClient.withUserContext(otherUserId, async (client) => {
            return client.query<{ id: string }>(
                `SELECT id FROM memories WHERE id = $1`,
                [otherMemoryId]
            );
        });
        expect(memory.rows).toHaveLength(1);
    });

    it('should emit usage event on success', async () => {
        // Create another memory to delete
        let tempId: string;
        await adminClient.withUserContext(userId, async (client) => {
            const content = 'Temp memory';
            const embedding = await embedder.embed(content);
            const vectorLiteral = `[${embedding.vector.join(',')}]`;
            const contentHash = crypto.createHash('sha256').update(content).digest('hex');
            const res = await client.query<{ id: string }>(
                `INSERT INTO memories (user_id, namespace, content, embedding, content_hash)
                 VALUES ($1, $2, $3, $4::vector, $5)
                 RETURNING id`,
                [userId, 'default', content, vectorLiteral, contentHash]
            );
            tempId = res.rows[0].id;
        });
        await forgetTool.forget(apiKey, tempId!);
        const events = await adminClient.withUserContext(userId, async (client) => {
            return client.query<{ event_type: string }>(
                `SELECT event_type FROM usage_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [userId]
            );
        });
        expect(events.rows).toHaveLength(1);
        expect(events.rows[0].event_type).toBe('forget');
    });
});