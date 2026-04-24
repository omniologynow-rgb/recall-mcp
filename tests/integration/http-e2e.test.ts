import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RecallServer } from '../../src/server.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { DatabaseClient } from '../../src/db/client.js';
import { AuthService } from '../../src/auth/index.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

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

describe('HTTP end-to-end tool call', () => {
    let container: any;
    let server: RecallServer;
    let db: DatabaseClient;
    let auth: AuthService;
    let originalEnv: NodeJS.ProcessEnv;
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
        
        // Apply migrations
        db = new DatabaseClient(connectionString);
        await applyMigrations(db);
        
        // Set environment variables
        originalEnv = { ...process.env };
        process.env.NODE_ENV = 'production';
        process.env.DATABASE_URL = connectionString;
        process.env.OPENAI_API_KEY = 'test-key'; // not used because MockEmbedder

        // Create server with HTTP transport and start it
        const embedder = new MockEmbedder();
        server = new RecallServer(embedder, {
            transport: 'http',
            port: 0, // random port
            enableDnsRebindingProtection: false,
        });
        await server.start();

        // Create a test user and API key
        auth = new AuthService(db);
        userId = randomUUID();
        const email = `test-${userId}@example.com`;
        await db.query(
            'INSERT INTO users (id, email, tier) VALUES ($1, $2, $3)',
            [userId, email, 'free']
        );
        const keyResult = await auth.generateApiKey(userId);
        apiKey = keyResult.key;
    });

    afterAll(async () => {
        if (server) {
            await server.stop();
        }
        // Restore environment
        process.env = originalEnv;
        if (container) {
            await container.stop();
        }
    });

    function makeJsonRpcRequest(method: string, params: any) {
        return {
            jsonrpc: '2.0',
            id: randomUUID(),
            method,
            params,
        };
    }

    it('should process a remember tool call over HTTP', async () => {
        const request = makeJsonRpcRequest('tools/call', {
            name: 'remember',
            arguments: {
                apiKey,
                content: 'The sky is blue.',
                namespace: 'test',
            },
        });

        const response = await server.fastify.inject({
            method: 'POST',
            url: '/mcp',
            headers: {
                'authorization': `Bearer ${apiKey}`,
                'content-type': 'application/json',
                'accept': 'application/json, text/event-stream',
            },
            payload: JSON.stringify(request),
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body).toHaveProperty('jsonrpc', '2.0');
        expect(body).toHaveProperty('id', request.id);
        expect(body).toHaveProperty('result');
        expect(body.result).toHaveProperty('content');
        expect(body.result.content).toBeInstanceOf(Array);
        expect(body.result.content[0]).toHaveProperty('type', 'text');
        const text = body.result.content[0].text;
        const parsed = JSON.parse(text);
        expect(parsed).toHaveProperty('id');
        expect(typeof parsed.id).toBe('string');
    });

    it('should reject unauthorized requests', async () => {
        const request = makeJsonRpcRequest('tools/call', {
            name: 'remember',
            arguments: {
                apiKey: 'invalid-key',
                content: 'Should fail',
                namespace: 'test',
            },
        });

        const response = await server.fastify.inject({
            method: 'POST',
            url: '/mcp',
            headers: {
                'authorization': 'Bearer invalid-key',
                'content-type': 'application/json',
            },
            payload: JSON.stringify(request),
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body).toHaveProperty('error', 'Unauthorized');
    });

    it('should reject missing authorization header', async () => {
        const request = makeJsonRpcRequest('tools/call', {
            name: 'remember',
            arguments: {
                apiKey: 'anything',
                content: 'Should fail',
                namespace: 'test',
            },
        });

        const response = await server.fastify.inject({
            method: 'POST',
            url: '/mcp',
            headers: {
                'content-type': 'application/json',
            },
            payload: JSON.stringify(request),
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body).toHaveProperty('error', 'Missing or invalid Authorization header');
    });
});