import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RecallServer } from '../../src/server.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function applyMigrations(client: any) {
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

describe('HTTP health endpoints', () => {
    let container: any;
    let server: RecallServer;
    let originalEnv: NodeJS.ProcessEnv;

    beforeAll(async () => {
        // Start PostgreSQL container with pgvector
        container = await new PostgreSqlContainer('pgvector/pgvector:pg15')
            .withDatabase('testdb')
            .withUsername('test')
            .withPassword('test')
            .withExposedPorts(5432)
            .start();

        const connectionString = `postgresql://test:test@${container.getHost()}:${container.getPort()}/testdb`;
        
        // Apply migrations using DatabaseClient
        const adminClient = new (await import('../../src/db/client.js')).DatabaseClient(connectionString);
        await applyMigrations(adminClient);
        await adminClient.close();

        // Set DATABASE_URL environment variable
        originalEnv = { ...process.env };
        process.env.NODE_ENV = 'production';
        process.env.DATABASE_URL = connectionString;
        process.env.OPENAI_API_KEY = 'test-key'; // not used because MockEmbedder

        // Create server with HTTP transport (but don't start listening)
        const embedder = new MockEmbedder();
        server = new RecallServer(embedder, {
            transport: 'http',
            port: 0, // random port (not used since we won't call start)
            enableDnsRebindingProtection: false,
        });
        // Note: we don't call server.start() because we'll use fastify.inject()
    });

    afterAll(async () => {
        // Restore environment
        process.env = originalEnv;
        if (container) {
            await container.stop();
        }
    });

    describe('GET /health', () => {
        it('returns 200 with health status', async () => {
            const response = await server.fastify.inject({
                method: 'GET',
                url: '/health',
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body).toHaveProperty('ok', true);
            expect(body).toHaveProperty('version');
            expect(body).toHaveProperty('db', 'up');
            expect(body).toHaveProperty('embedder', 'up');
            expect(body).toHaveProperty('timestamp');
        });
    });

    describe('GET /ready', () => {
        it('returns 200 when everything is up', async () => {
            const response = await server.fastify.inject({
                method: 'GET',
                url: '/ready',
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body).toHaveProperty('ok', true);
            expect(body).toHaveProperty('db', 'up');
            expect(body).toHaveProperty('embedder', 'up');
            expect(body).toHaveProperty('migrations', 'current');
        });
    });
});