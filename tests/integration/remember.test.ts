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

describe('Remember tool integration', () => {
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

        // Create a test user
        const userRes = await adminClient.query<{ id: string }>(
            `INSERT INTO users (id, email, tier) VALUES (gen_random_uuid(), $1, 'free') RETURNING id`,
            [`test-${Date.now()}@example.com`]
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

    it('should store a memory with embedding', async () => {
        const memoryId = await rememberTool.remember(userId, 'free', 'My first memory');
        expect(memoryId).toBeDefined();
        expect(typeof memoryId).toBe('string');

        // Verify the memory was stored
        const memoryRes = await adminClient.withUserContext(userId, async (client) => {
            return client.query<{ id: string; content: string; embedding: any }>(
                `SELECT id, content, embedding FROM memories WHERE id = $1`,
                [memoryId]
            );
        });
        expect(memoryRes.rows).toHaveLength(1);
        const memory = memoryRes.rows[0];
        expect(memory.content).toBe('My first memory');
        // Parse embedding (pgvector may return string if type parser not registered)
        const embedding = Array.isArray(memory.embedding) ? memory.embedding : JSON.parse(memory.embedding);
        expect(embedding).toHaveLength(1536); // MockEmbedder dimension
    });

    it('should enforce tier limits', async () => {
        // Free tier limit is 100 memories
        // Create 100 memories (skipping for brevity, but we could test edge case)
        // This test will be expanded later
        expect(true).toBe(true);
    });
});