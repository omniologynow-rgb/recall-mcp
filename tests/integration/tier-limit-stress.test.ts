import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { RememberTool } from '../../src/tools/remember.js';
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

describe('Tier limit stress test', () => {
    let container: any;
    let adminClient: DatabaseClient;
    let embedder: MockEmbedder;
    let rememberTool: RememberTool;
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

        // Create a free-tier user
        const userRes = await adminClient.query<{ id: string }>(
            `INSERT INTO users (id, email, tier) VALUES (gen_random_uuid(), $1, 'free') RETURNING id`,
            [`stress-${Date.now()}@example.com`]
        );
        userId = userRes.rows[0].id;

        // Create an API key for the user

        // Create embedder and tool
        embedder = new MockEmbedder();
        rememberTool = new RememberTool(adminClient, embedder);
    });

    afterAll(async () => {
        await adminClient?.close();
        await container?.stop();
    });

    it('should allow exactly 100 memories under free tier with concurrent requests', async () => {
        const concurrency = 200;
        const promises = Array.from({ length: concurrency }, (_, i) => {
            const content = `memory ${i} at ${Date.now()}`;
            return rememberTool.remember(userId, 'free', content);
        });
        const results = await Promise.allSettled(promises);
        const succeeded = results.filter(r => r.status === 'fulfilled');
        const failed = results.filter(r => r.status === 'rejected');
        // Expect exactly 100 succeeded, 100 failed
        expect(succeeded.length).toBe(100);
        expect(failed.length).toBe(100);
        // All failures should be tier limit errors
        failed.forEach(result => {
            const err = (result as PromiseRejectedResult).reason;
            expect(err).toBeInstanceOf(Error);
            if ('code' in err) {
                expect(err.code).toBe('limit_exceeded');
                expect(err.message).toContain('Free tier allows 100 memories');
            } else {
                // Fallback for non-ToolError (should not happen)
                expect(err.message).toMatch(/free tier limit exceeded/);
            }
        });
        // Verify database count
        const countRes = await adminClient.withUserContext(userId, async (client) => {
            return client.query<{ count: string }>(`SELECT COUNT(*) FROM memories WHERE user_id = $1`, [userId]);
        });
        const count = parseInt(countRes.rows[0].count, 10);
        expect(count).toBe(100);
        // Verify usage events: 100 remember events (successful) + maybe dedupe? none
        const usageRes = await adminClient.withUserContext(userId, async (client) => {
            return client.query<{ event_type: string; count: string }>(
                `SELECT event_type, COUNT(*) FROM usage_events WHERE user_id = $1 GROUP BY event_type`,
                [userId]
            );
        });
        const rememberEvents = usageRes.rows.find(r => r.event_type === 'remember');
        expect(rememberEvents?.count).toBe('100');
        // No dedupe events
        const dedupeEvents = usageRes.rows.find(r => r.event_type === 'remember_dedupe');
        expect(dedupeEvents).toBeUndefined();
    }, 30000); // 30 second timeout
});