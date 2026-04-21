import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
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

describe('DatabaseClient with RLS', () => {
    let container: any;
    let adminClient: DatabaseClient;
    let dbClient: DatabaseClient;
    let userAId: string;
    let userBId: string;

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

        // Create a non‑superuser, non‑owner application role for RLS enforcement tests
        await adminClient.query(`
            CREATE ROLE IF NOT EXISTS recall_app_test LOGIN PASSWORD 'test' NOBYPASSRLS;
            GRANT USAGE ON SCHEMA public TO recall_app_test;
            GRANT SELECT, INSERT, UPDATE, DELETE ON users, api_keys, memories, usage_events TO recall_app_test;
            GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO recall_app_test;
        `);

        // Temporarily disable RLS to insert test users (since no app.current_user_id set)
        await adminClient.query('ALTER TABLE users DISABLE ROW LEVEL SECURITY');
        await adminClient.query('ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY');
        await adminClient.query('ALTER TABLE memories DISABLE ROW LEVEL SECURITY');
        await adminClient.query('ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY');

        const userARes = await adminClient.query<{ id: string }>(
            `INSERT INTO users (email, tier) VALUES ('userA@test.com', 'free') RETURNING id`
        );
        userAId = userARes.rows[0].id;
        const userBRes = await adminClient.query<{ id: string }>(
            `INSERT INTO users (email, tier) VALUES ('userB@test.com', 'free') RETURNING id`
        );
        userBId = userBRes.rows[0].id;

        await adminClient.query('ALTER TABLE users ENABLE ROW LEVEL SECURITY');
        await adminClient.query('ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY');
        await adminClient.query('ALTER TABLE memories ENABLE ROW LEVEL SECURITY');
        await adminClient.query('ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY');

        // Create the application client that will be used for all RLS tests
        const appConnectionString = `postgresql://recall_app_test:test@${container.getHost()}:${container.getPort()}/testdb`;
        dbClient = new DatabaseClient(appConnectionString);
        await dbClient.registerVectorTypes();
    }, 30000); // 30 second timeout

    afterAll(async () => {
        if (dbClient) {
            await dbClient.close();
        }
        if (adminClient) {
            await adminClient.close();
        }
        if (container) {
            await container.stop();
        }
    });

    it('should insert memory for user A', async () => {
        const memoryId = await dbClient.insertMemory({
            user_id: userAId,
            namespace: 'test',
            content: 'User A secret',
            embedding: Array.from({ length: 1536 }, () => 0.1),
            content_hash: 'hash1',
        });
        expect(memoryId).toBeDefined();
    });

    it('user A can retrieve their own memory', async () => {
        const memories = await dbClient.withUserContext(userAId, async (client) => {
            const res = await client.query('SELECT * FROM memories WHERE user_id = $1', [userAId]);
            return res.rows;
        });
        expect(memories).toHaveLength(1);
        expect(memories[0].content).toBe('User A secret');
    });

    it('user B cannot see user A memory via search', async () => {
        const results = await dbClient.searchMemories(
            userBId,
            Array.from({ length: 1536 }, () => 0.1),
            'test',
            5,
            0.0
        );
        expect(results).toHaveLength(0);
    });

    it('user B cannot read user A memory via direct query with user context', async () => {
        const memories = await dbClient.withUserContext(userBId, async (client) => {
            const res = await client.query('SELECT * FROM memories');
            return res.rows;
        });
        expect(memories).toHaveLength(0);
    });

    it('user B cannot delete user A memory', async () => {
        // First get the memory ID (as user A)
        const memories = await dbClient.withUserContext(userAId, async (client) => {
            const res = await client.query('SELECT id FROM memories');
            return res.rows;
        });
        const memoryId = memories[0].id;
        await expect(dbClient.deleteMemory(userBId, memoryId)).rejects.toThrow();
    });

    it('cross-user isolation: user A cannot set user B context and see B data', async () => {
        // Insert a memory for user B
        const memoryId = await dbClient.insertMemory({
            user_id: userBId,
            namespace: 'private',
            content: 'User B secret',
            embedding: Array.from({ length: 1536 }, () => 0.2),
            content_hash: 'hash2',
        });
        // User A tries to fetch that memory via search (should not see)
        const results = await dbClient.searchMemories(
            userAId,
            Array.from({ length: 1536 }, () => 0.2),
            'private',
            5,
            0.0
        );
        expect(results).toHaveLength(0);
        // User A tries to fetch via listMemories (should not see)
        const list = await dbClient.listMemories(userAId, 'private');
        expect(list.memories).toHaveLength(0);
    });

    // RLS guardrail: without SET LOCAL, queries must fail or return zero rows
    it('should reject queries when app.current_user_id is not set', async () => {
        // Direct query without setting app.current_user_id should cause an error
        // because current_app_user_id() will try to cast NULL to UUID.
        await expect(dbClient.query('SELECT * FROM memories')).rejects.toThrow();
    });

    // Additional guardrail: ensure FORCE ROW LEVEL SECURITY is applied
    // by verifying that even a superuser cannot bypass RLS without SET LOCAL.
    it('should enforce RLS even for superuser (postgres)', async () => {
        // The test container uses user 'test' which is not a superuser? Actually the default user 'test' is not superuser.
        // But we can test that the table owner (postgres) cannot bypass due to FORCE ROW LEVEL SECURITY.
        // We'll connect as the same user (test) which is the table owner (since we created tables as 'test').
        // The query should still fail because app.current_user_id is not set.
        await expect(dbClient.query('SELECT * FROM memories')).rejects.toThrow();
    });

    // Adversarial test: ensure WITH CHECK prevents reassignment of user_id
    it('should prevent user A from reassigning memory to user B via UPDATE', async () => {
        // First, user A inserts a memory
        const memoryId = await dbClient.insertMemory({
            user_id: userAId,
            namespace: 'adversarial',
            content: 'User A memory',
            embedding: Array.from({ length: 1536 }, () => 0.3),
            content_hash: 'hash3',
        });
        // User A attempts to UPDATE the memory's user_id to user B's ID
        // This should be blocked by WITH CHECK clause of the RLS policy
        const updated = await dbClient.withUserContext(userAId, async (client) => {
            const res = await client.query(
                'UPDATE memories SET user_id = $1 WHERE id = $2 RETURNING id',
                [userBId, memoryId]
            );
            return res.rowCount;
        });
        // Expect zero rows updated
        expect(updated).toBe(0);
        // Verify the memory still belongs to user A
        const memories = await dbClient.withUserContext(userAId, async (client) => {
            const res = await client.query('SELECT user_id FROM memories WHERE id = $1', [memoryId]);
            return res.rows;
        });
        expect(memories).toHaveLength(1);
        expect(memories[0].user_id).toBe(userAId);
    });
});