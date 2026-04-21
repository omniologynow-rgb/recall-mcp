import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
import { AuthService } from '../../src/auth/index.js';
import { ListMemoriesTool } from '../../src/tools/list.js';
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

describe('List memories tool integration', () => {
    let container: any;
    let adminClient: DatabaseClient;
    let authService: AuthService;
    let listTool: ListMemoriesTool;
    let userId: string;
    let apiKey: string;

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
        authService = new AuthService(adminClient);
        const { key } = await authService.generateApiKey(userId, 'test key');
        apiKey = key;

        // Create tool
        listTool = new ListMemoriesTool(adminClient, authService);

        // Seed memories in different namespaces
        await adminClient.withUserContext(userId, async (client) => {
            const memories = [
                { content: 'Memory A', namespace: 'default' },
                { content: 'Memory B', namespace: 'default' },
                { content: 'Memory C', namespace: 'work' },
                { content: 'Memory D', namespace: 'work' },
                { content: 'Memory E', namespace: 'work' },
                { content: 'Memory F', namespace: 'personal' },
            ];
            for (const mem of memories) {
                const embedding = Array.from({ length: 1536 }, () => Math.random() * 0.1);
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

    it('should list memories for default namespace', async () => {
        const results = await listTool.list(apiKey, 'default');
        expect(results).toHaveLength(2);
        results.forEach(r => {
            expect(r.namespace).toBe('default');
            expect(r).toHaveProperty('id');
            expect(r).toHaveProperty('content');
            expect(r).toHaveProperty('created_at');
            expect(r).toHaveProperty('updated_at');
        });
        const contents = results.map(r => r.content).sort();
        expect(contents).toEqual(['Memory A', 'Memory B']);
    });

    it('should list memories for specific namespace', async () => {
        const results = await listTool.list(apiKey, 'work');
        expect(results).toHaveLength(3);
        results.forEach(r => {
            expect(r.namespace).toBe('work');
        });
    });

    it('should respect limit and offset', async () => {
        // Sorted by created_at ascending? Let's assume order by created_at
        const results1 = await listTool.list(apiKey, 'work', 2, 0);
        expect(results1).toHaveLength(2);
        const results2 = await listTool.list(apiKey, 'work', 2, 2);
        expect(results2).toHaveLength(1);
        // Ensure no overlap
        const ids1 = results1.map(r => r.id);
        const ids2 = results2.map(r => r.id);
        expect(ids1.some(id => ids2.includes(id))).toBe(false);
    });

    it('should emit usage event', async () => {
        await listTool.list(apiKey, 'default');
        const events = await adminClient.withUserContext(userId, async (client) => {
            return client.query<{ event_type: string }>(
                `SELECT event_type FROM usage_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [userId]
            );
        });
        expect(events.rows).toHaveLength(1);
        expect(events.rows[0].event_type).toBe('list');
    });
});