import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RecallServer } from '../../src/server.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { DatabaseClient } from '../../src/db/client.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHmac } from 'crypto';

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

describe('Webhook HMAC verification', () => {
    let container: any;
    let server: RecallServer;
    let db: DatabaseClient;
    let originalEnv: NodeJS.ProcessEnv;
    let userId: string;
    const secret = 'test-webhook-secret';

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
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.MCPIZE_BILLING_WEBHOOK_SECRET = secret;

        // Create server with HTTP transport and start it
        const embedder = new MockEmbedder();
        server = new RecallServer(embedder, {
            transport: 'http',
            port: 0, // random port
            enableDnsRebindingProtection: false,
        });
        await server.start();

        // Create a test user
        userId = randomUUID();
        const email = `test-${userId}@example.com`;
        await db.query(
            'INSERT INTO users (id, email, tier) VALUES ($1, $2, $3)',
            [userId, email, 'free']
        );
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

    function computeHmac(payload: Buffer): string {
        return createHmac('sha256', secret).update(payload).digest('hex');
    }

    it('should update user tier on valid HMAC', async () => {
        const payload = JSON.stringify({
            userId,
            tier: 'pro',
        });
        const signature = computeHmac(Buffer.from(payload));

        const response = await server.fastify.inject({
            method: 'POST',
            url: '/webhooks/mcpize/subscription',
            headers: {
                'x-mcpize-signature': signature,
                'content-type': 'application/json',
            },
            payload,
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body).toHaveProperty('updated', true);

        // Verify tier updated in database
        const res = await db.query('SELECT tier FROM users WHERE id = $1', [userId]);
        expect(res.rows[0].tier).toBe('pro');
    });

    it('should reject invalid HMAC', async () => {
        const payload = JSON.stringify({
            userId,
            tier: 'team',
        });
        const signature = 'invalid-signature';

        const response = await server.fastify.inject({
            method: 'POST',
            url: '/webhooks/mcpize/subscription',
            headers: {
                'x-mcpize-signature': signature,
                'content-type': 'application/json',
            },
            payload,
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body).toHaveProperty('error', 'Invalid signature');

        // Verify tier unchanged
        const res = await db.query('SELECT tier FROM users WHERE id = $1', [userId]);
        expect(res.rows[0].tier).toBe('pro'); // still pro from previous test
    });

    it('should reject missing signature header', async () => {
        const payload = JSON.stringify({
            userId,
            tier: 'team',
        });

        const response = await server.fastify.inject({
            method: 'POST',
            url: '/webhooks/mcpize/subscription',
            headers: {
                'content-type': 'application/json',
            },
            payload,
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body).toHaveProperty('error', 'Missing signature header');
    });

    it('should reject missing secret configuration', async () => {
        // Temporarily unset secret
        delete process.env.MCPIZE_BILLING_WEBHOOK_SECRET;

        const payload = JSON.stringify({
            userId,
            tier: 'team',
        });
        const signature = computeHmac(Buffer.from(payload));

        const response = await server.fastify.inject({
            method: 'POST',
            url: '/webhooks/mcpize/subscription',
            headers: {
                'x-mcpize-signature': signature,
                'content-type': 'application/json',
            },
            payload,
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body).toHaveProperty('error', 'Webhook secret not configured');

        // Restore secret
        process.env.MCPIZE_BILLING_WEBHOOK_SECRET = secret;
    });
});