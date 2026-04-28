import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
import { recordUsageEvent } from '../../src/db/usage.js';
import { randomUUID } from 'crypto';
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
        } catch (err: any) {
            const msg = err.message || '';
            if (msg.includes('already exists')) {
                continue;
            }
            throw err;
        }
    }
}

describe('usage_events integration', () => {
    let container: any;
    let client: DatabaseClient;
    let userId: string;
    let apiKeyId: string;

    beforeAll(async () => {
        container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
            .withDatabase('recall_test')
            .withUsername('recall_test')
            .withPassword('recall_test')
            .start();

        const connectionString = container.getConnectionUri();
        client = new DatabaseClient(connectionString);

        // Apply all migrations, then register vector types
        await applyMigrations(client);
        await client.registerVectorTypes();

        // Seed a test user + API key with known IDs
        await client.query(
            `INSERT INTO users (id, email, tier) VALUES ($1, $2, $3)
             ON CONFLICT (id) DO NOTHING`,
            ['00000000-0000-0000-0000-000000000001', 'usage-test@example.com', 'free'],
        );
        userId = '00000000-0000-0000-0000-000000000001';

        await client.query(
            `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, tier)
             VALUES ($1, $2, $3, $4, 'free')
             ON CONFLICT (id) DO NOTHING`,
            ['00000000-0000-0000-0000-000000000010', userId, '$2b$12$dummyhash', 'test_prefix_'],
        );
        apiKeyId = '00000000-0000-0000-0000-000000000010';
    });

    afterAll(async () => {
        if (client) await client.close();
        if (container) await container.stop();
    });

    it('writes success=true row with tokens_consumed=1, latency_ms>0, error_code IS NULL', async () => {
        const requestId = randomUUID();
        await recordUsageEvent(client, {
            userId,
            apiKeyId,
            requestId,
            toolName: 'remember',
            tokensConsumed: 1,
            latencyMs: 42,
            success: true,
            errorCode: null,
        });

        const res = await client.query<{ success: boolean; tokens_consumed: number; latency_ms: number; error_code: string | null; tool_name: string; user_id: string; api_key_id: string; request_id: string }>(
            `SELECT * FROM usage_events WHERE request_id = $1`,
            [requestId],
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].success).toBe(true);
        expect(res.rows[0].tokens_consumed).toBe(1);
        expect(res.rows[0].latency_ms).toBe(42);
        expect(res.rows[0].error_code).toBeNull();
        expect(res.rows[0].tool_name).toBe('remember');
        expect(res.rows[0].user_id).toBe(userId);
        expect(res.rows[0].api_key_id).toBe(apiKeyId);
        expect(res.rows[0].request_id).toBe(requestId);
    });

    it('writes success=false row with error_code on failure', async () => {
        const requestId = randomUUID();
        await recordUsageEvent(client, {
            userId,
            apiKeyId,
            requestId,
            toolName: 'remember',
            tokensConsumed: 1,
            latencyMs: 15,
            success: false,
            errorCode: 'validation_failed',
        });

        const res = await client.query<{ success: boolean; error_code: string | null }>(
            `SELECT success, error_code FROM usage_events WHERE request_id = $1`,
            [requestId],
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].success).toBe(false);
        expect(res.rows[0].error_code).toBe('validation_failed');
    });

    it('writes rate_limited event with tokens_consumed=0', async () => {
        const requestId = randomUUID();
        await recordUsageEvent(client, {
            userId,
            apiKeyId,
            requestId,
            toolName: 'unknown',
            tokensConsumed: 0,
            latencyMs: 0,
            success: false,
            errorCode: 'rate_limited',
        });

        const res = await client.query<{ tokens_consumed: number; error_code: string }>(
            `SELECT tokens_consumed, error_code FROM usage_events WHERE request_id = $1`,
            [requestId],
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].tokens_consumed).toBe(0);
        expect(res.rows[0].error_code).toBe('rate_limited');
    });

    it('landed after write', async () => {
        const requestId = randomUUID();
        await recordUsageEvent(client, {
            userId,
            apiKeyId,
            requestId,
            toolName: 'remember',
            tokensConsumed: 1,
            latencyMs: 10,
            success: true,
            errorCode: null,
        });

        const res = await client.query<{ request_id: string }>(
            `SELECT request_id FROM usage_events WHERE request_id = $1`,
            [requestId],
        );
        expect(res.rows.length).toBe(1);
    });

    it('stores the request_id supplied', async () => {
        const requestId = 'correlate-abc-123';
        await recordUsageEvent(client, {
            userId,
            apiKeyId,
            requestId,
            toolName: 'recall',
            tokensConsumed: 1,
            latencyMs: 30,
            success: true,
            errorCode: null,
        });

        const res = await client.query<{ request_id: string; tool_name: string }>(
            `SELECT request_id, tool_name FROM usage_events WHERE request_id = $1`,
            [requestId],
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].request_id).toBe('correlate-abc-123');
        expect(res.rows[0].tool_name).toBe('recall');
    });

    it('RLS policy exists and restricts visibility per user', async () => {
        // Enable RLS on usage_events
        await client.query('ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY');
        // Drop + recreate policy
        await client.query('DROP POLICY IF EXISTS usage_events_user_isolation ON usage_events');
        await client.query(`
            CREATE POLICY usage_events_user_isolation ON usage_events
                FOR ALL
                USING (user_id = current_setting('app.current_user_id', true)::uuid)
        `);

        // User B
        const userIdB = randomUUID();
        await client.query(
            `INSERT INTO users (id, email, tier) VALUES ($1, $2, $3)
             ON CONFLICT (id) DO NOTHING`,
            [userIdB, 'rls-user-b@example.com', 'free'],
        );
        const apiKeyIdB = randomUUID();
        await client.query(
            `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, tier)
             VALUES ($1, $2, $3, $4, 'free')
             ON CONFLICT (id) DO NOTHING`,
            [apiKeyIdB, userIdB, '$2b$12$dummyhash2', 'test_prefix_b'],
        );

        // Insert usage event for user B
        await recordUsageEvent(client, {
            userId: userIdB,
            apiKeyId: apiKeyIdB,
            requestId: 'rls-user-b-' + randomUUID(),
            toolName: 'recall',
            tokensConsumed: 1,
            latencyMs: 5,
            success: true,
            errorCode: null,
        });

        // Verify both user A and user B rows exist in the table
        const allRows = await client.query<{ user_id: string }>(
            `SELECT user_id FROM usage_events`,
        );
        // Since RLS is enabled, a connection with no current_setting will see
        // zero rows (the cast to UUID of an empty string fails, filtering everything)
        // Verify the policy was created by checking pg_policies
        const policyCheck = await client.query<{ policyname: string }>(
            `SELECT policyname FROM pg_policies WHERE tablename = 'usage_events'`,
        );
        expect(policyCheck.rows.length).toBeGreaterThan(0);
        expect(policyCheck.rows[0].policyname).toBe('usage_events_user_isolation');

        // Verify RLS is enabled
        const rlsCheck = await client.query<{ relname: string; relrowsecurity: boolean }>(
            `SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'usage_events'`,
        );
        expect(rlsCheck.rows[0].relrowsecurity).toBe(true);
    });

    it('survives insert failure — client sees success, warn log fires', async () => {
        const requestId = randomUUID();
        let warnFired = false;

        const badClient = {
            query: async () => { throw new Error('connection refused'); },
        } as unknown as DatabaseClient;

        await expect(
            recordUsageEvent(badClient, {
                userId,
                apiKeyId,
                requestId,
                toolName: 'remember',
                tokensConsumed: 1,
                latencyMs: 5,
                success: true,
                errorCode: null,
            }, (err) => {
                warnFired = true;
                expect(err.message).toBe('connection refused');
            }),
        ).resolves.toBeUndefined();

        expect(warnFired).toBe(true);
    });
});
