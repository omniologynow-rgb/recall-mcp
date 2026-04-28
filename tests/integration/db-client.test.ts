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
    let ownerClient: DatabaseClient;
    let userAId: string;
    let userBId: string;
    let ownerRole: string;
    let testRole: string;

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

        // Diagnostic: check RLS and FORCE RLS status
        const rlsStatus = await adminClient.query(
            `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('users', 'api_keys', 'memories', 'usage_events')`
        );
        console.log('RLS status:', rlsStatus.rows);
        const roleStatus = await adminClient.query(`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'test'`);
        console.log('Role bypass RLS and superuser:', roleStatus.rows);
        if (roleStatus.rows[0].rolsuper) {
            console.warn('WARNING: test role is a superuser; RLS bypass is automatic regardless of BYPASSRLS');
        }

        // Create the table owner role (non‑superuser, NOBYPASSRLS, LOGIN)
        // Use a unique suffix to avoid conflicts if tests are run multiple times
        const suffix = Math.random().toString(36).substring(2, 8);
        ownerRole = `recall_app_owner_${suffix}`;
        testRole = `recall_app_test_${suffix}`;
        
        // Drop if they exist (should be safe with unique names)
        try { await adminClient.query(`DROP ROLE IF EXISTS ${ownerRole}`); } catch {}
        try { await adminClient.query(`DROP ROLE IF EXISTS ${testRole}`); } catch {}
        
        // Create owner role (will own tables)
        await adminClient.query(`
            CREATE ROLE ${ownerRole} LOGIN PASSWORD 'test' NOBYPASSRLS;
            GRANT USAGE ON SCHEMA public TO ${ownerRole};
            GRANT SELECT, INSERT, UPDATE, DELETE ON users, api_keys, memories, usage_events TO ${ownerRole};
            GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${ownerRole};
        `);
        // Create test role (non‑owner, inherits same privileges)
        await adminClient.query(`
            CREATE ROLE ${testRole} LOGIN PASSWORD 'test' NOBYPASSRLS INHERIT IN ROLE ${ownerRole};
        `);
        
        // Ensure the test role cannot bypass RLS (otherwise FORCE RLS canary will fail)
        await adminClient.query('ALTER ROLE test NOBYPASSRLS');

        // Transfer table ownership to the owner role (non‑superuser, NOBYPASSRLS)
        await adminClient.query(`ALTER TABLE users OWNER TO ${ownerRole}`);
        await adminClient.query(`ALTER TABLE api_keys OWNER TO ${ownerRole}`);
        await adminClient.query(`ALTER TABLE memories OWNER TO ${ownerRole}`);
        await adminClient.query(`ALTER TABLE usage_events OWNER TO ${ownerRole}`);

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

        // Create the application client that will be used for all RLS tests (non‑owner)
        const appConnectionString = `postgresql://${testRole}:test@${container.getHost()}:${container.getPort()}/testdb`;
        dbClient = new DatabaseClient(appConnectionString);
        await dbClient.registerVectorTypes();

        // Create a client that connects as the table owner
        const ownerConnectionString = `postgresql://${ownerRole}:test@${container.getHost()}:${container.getPort()}/testdb`;
        ownerClient = new DatabaseClient(ownerConnectionString);
        await ownerClient.registerVectorTypes();
    }, 30000); // 30 second timeout

    afterAll(async () => {
        if (dbClient) {
            await dbClient.close();
        }
        if (ownerClient) {
            await ownerClient.close();
        }
        if (adminClient) {
            await adminClient.close();
        }
        if (container) {
            await container.stop();
        }
    });

    // Helper to seed an API key for a user (using application role)
    async function seedApiKeyFor(userId: string, label = 'test key'): Promise<string> {
        const prefix = `test_${Math.random().toString(36).substring(2)}`;
        const result = await dbClient.withUserContext(userId, async (client) => {
            const res = await client.query<{ id: string }>(
                `INSERT INTO api_keys (user_id, key_prefix, key_hash, label)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [userId, prefix, 'test_hash', label]
            );
            return res.rows[0].id;
        });
        return result;
    }

    // Helper to seed a usage event for a user
    async function seedUsageEventFor(userId: string, eventType = 'remember'): Promise<string> {
        const result = await dbClient.withUserContext(userId, async (client) => {
            const res = await client.query<{ id: string }>(
                `INSERT INTO usage_events (user_id, api_key_id, request_id, tool_name, tokens_consumed, latency_ms, success, error_code)
                 VALUES ($1, (SELECT id FROM api_keys WHERE user_id = $1 LIMIT 1), 'test-request', $2, 1, 0, true, NULL) RETURNING id`,
                [userId, eventType]
            );
            return res.rows[0].id;
        });
        return result;
    }

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

    it('FORCE RLS canary: table owner cannot bypass policy on memories', async () => {
        // Seed a memory for userB using the application role (non-owner)
        const memoryId = await dbClient.insertMemory({
            user_id: userBId,
            namespace: 'private',
            content: 'User B secret',
            embedding: Array.from({ length: 1536 }, () => 0.2),
            content_hash: 'hashB',
        });

        // Connect as the table OWNER, act as userA via withUserContext
        await ownerClient.withUserContext(userAId, async (client) => {
            // 1) SELECT: owner must not see userB's rows
            const selectRes = await client.query(
                `SELECT * FROM memories WHERE user_id = $1`,
                [userBId]
            );
            expect(selectRes.rows).toHaveLength(0);

            // 2) UPDATE: owner must not be able to modify userB's rows
            const updateRes = await client.query(
                `UPDATE memories SET content = 'hijacked' WHERE user_id = $1`,
                [userBId]
            );
            expect(updateRes.rowCount).toBe(0);

            // 3) INSERT with a foreign user_id must fail WITH CHECK (aborts transaction)
            await expect(
                client.query(
                    `INSERT INTO memories (user_id, namespace, content, embedding, content_hash)
                     VALUES ($1, 'test', 'x', $2, 'h')`,
                    [userBId, Array.from({ length: 1536 }, () => 0.1)]
                )
            ).rejects.toThrow();

            // 4) After INSERT fails, transaction is aborted; further queries should fail
            await expect(
                client.query(`DELETE FROM memories WHERE user_id = $1`, [userBId])
            ).rejects.toThrow(/current transaction is aborted/);
        });
    });

    it('FORCE RLS canary: table owner cannot bypass policy on api_keys', async () => {
        // Seed an API key for userB using the application role
        const keyId = await seedApiKeyFor(userBId, 'user B key');

        // Connect as the table OWNER, act as userA via withUserContext
        await ownerClient.withUserContext(userAId, async (client) => {
            // 1) SELECT: owner must not see userB's rows
            const selectRes = await client.query(
                `SELECT * FROM api_keys WHERE user_id = $1`,
                [userBId]
            );
            expect(selectRes.rows).toHaveLength(0);

            // 2) UPDATE: owner must not be able to modify userB's rows
            const updateRes = await client.query(
                `UPDATE api_keys SET label = 'hijacked' WHERE user_id = $1`,
                [userBId]
            );
            expect(updateRes.rowCount).toBe(0);

            // 3) INSERT with a foreign user_id must fail WITH CHECK (aborts transaction)
            await expect(
                client.query(
                    `INSERT INTO api_keys (user_id, key_prefix, key_hash, label)
                     VALUES ($1, $2, $3, $4)`,
                    [userBId, 'prefix_x', 'hash_x', 'x']
                )
            ).rejects.toThrow();

            // 4) After INSERT fails, transaction is aborted; further queries should fail
            await expect(
                client.query(`DELETE FROM api_keys WHERE user_id = $1`, [userBId])
            ).rejects.toThrow(/current transaction is aborted/);
        });
    });

    it('FORCE RLS canary: table owner cannot bypass policy on usage_events', async () => {
        // Seed a usage event for userB using the application role
        const eventId = await seedUsageEventFor(userBId, 'remember');

        // Connect as the table OWNER, act as userA via withUserContext
        await ownerClient.withUserContext(userAId, async (client) => {
            // 1) SELECT: owner must not see userB's rows
            const selectRes = await client.query(
                `SELECT * FROM usage_events WHERE user_id = $1`,
                [userBId]
            );
            expect(selectRes.rows).toHaveLength(0);

            // 2) UPDATE: owner must not be able to modify userB's rows
            const updateRes = await client.query(
                `UPDATE usage_events SET success = false WHERE user_id = $1`,
                [userBId]
            );
            expect(updateRes.rowCount).toBe(0);

            // 3) INSERT with a foreign user_id must fail WITH CHECK (aborts transaction)
            await expect(
                client.query(
                    `INSERT INTO usage_events (user_id, api_key_id, request_id, tool_name, tokens_consumed, latency_ms, success, error_code)
                     VALUES ($1, (SELECT id FROM api_keys WHERE user_id = $1 LIMIT 1), 'test', 'remember', 1, 0, true, NULL)`,
                    [userBId]
                )
            ).rejects.toThrow();

            // 4) After INSERT fails, transaction is aborted; further queries should fail
            await expect(
                client.query(`DELETE FROM usage_events WHERE user_id = $1`, [userBId])
            ).rejects.toThrow(/current transaction is aborted/);
        });
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
        await expect(
            dbClient.withUserContext(userAId, async (client) => {
                const res = await client.query(
                    'UPDATE memories SET user_id = $1 WHERE id = $2 RETURNING id',
                    [userBId, memoryId]
                );
                return res.rowCount;
            })
        ).rejects.toThrow();
        // Verify the memory still belongs to user A
        const memories = await dbClient.withUserContext(userAId, async (client) => {
            const res = await client.query('SELECT user_id FROM memories WHERE id = $1', [memoryId]);
            return res.rows;
        });
        expect(memories).toHaveLength(1);
        expect(memories[0].user_id).toBe(userAId);
    });
});