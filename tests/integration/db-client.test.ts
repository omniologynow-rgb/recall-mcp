import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('DatabaseClient with RLS', () => {
    let container: any;
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
        dbClient = new DatabaseClient(connectionString);

        // Apply migration
        const migrationPath = path.join(__dirname, '../../supabase/migrations/0001_init.sql');
        const migrationSql = await fs.readFile(migrationPath, 'utf8');
        // Split by semicolon and execute each statement (simple, but works for our migration)
        const statements = migrationSql.split(';').filter(s => s.trim());
        for (const stmt of statements) {
            try {
                await dbClient.query(stmt);
            } catch (err) {
                // Ignore duplicate extension errors etc.
                if (!(err instanceof Error && err.message.includes('already exists'))) {
                    throw err;
                }
            }
        }

        // Create two test users directly via service role (bypass RLS)
        // We need to insert into users table, but RLS policies restrict.
        // Since we are using service role (no app.current_user_id set), we need to temporarily disable RLS.
        // We'll use SET LOCAL app.current_user_id = NULL and rely on service role bypass? Actually service role has BYPASSRLS.
        // The policy uses current_app_user_id() which will error if setting is NULL.
        // Let's temporarily drop policies, insert users, then restore? Simpler: we can set app.current_user_id to a superuser UUID that matches no one.
        // We'll create a function to run as superuser (the postgres user). The container's default user is postgres.
        // Let's connect with superuser role: we can create a separate client with superuser credentials.
        // For simplicity, we'll just use the same client but set app.current_user_id to a dummy UUID that won't match any user.
        // The policy "USING (user_id = current_app_user_id())" will fail because we haven't inserted users yet.
        // We'll temporarily alter table to disable RLS, insert, then enable.
        await dbClient.query('ALTER TABLE users DISABLE ROW LEVEL SECURITY');
        await dbClient.query('ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY');
        await dbClient.query('ALTER TABLE memories DISABLE ROW LEVEL SECURITY');
        await dbClient.query('ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY');

        const userARes = await dbClient.query<{ id: string }>(
            `INSERT INTO users (email, tier) VALUES ('userA@test.com', 'free') RETURNING id`
        );
        userAId = userARes.rows[0].id;
        const userBRes = await dbClient.query<{ id: string }>(
            `INSERT INTO users (email, tier) VALUES ('userB@test.com', 'free') RETURNING id`
        );
        userBId = userBRes.rows[0].id;

        await dbClient.query('ALTER TABLE users ENABLE ROW LEVEL SECURITY');
        await dbClient.query('ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY');
        await dbClient.query('ALTER TABLE memories ENABLE ROW LEVEL SECURITY');
        await dbClient.query('ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY');
    }, 30000); // 30 second timeout

    afterAll(async () => {
        if (dbClient) {
            await dbClient.close();
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
        // Search with user B context should return empty (since RLS filters)
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
        // Using withUserContext as user B, query all memories (should see none)
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
        // Attempt delete as user B (should throw or delete zero rows)
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
});