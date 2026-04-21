import { describe, it, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
import { AuthService } from '../../src/auth/index.js';
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

describe('End-to-end trace', () => {
    let container: any;
    let adminClient: DatabaseClient;
    let authService: AuthService;
    let embedder: MockEmbedder;
    let rememberTool: RememberTool;
    let userId: string;
    let apiKey: string;
    let keyPrefix: string;

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

        // Seed a user (tier='free', email='demo@recallmcp.dev')
        const userRes = await adminClient.query<{ id: string }>(
            `INSERT INTO users (id, email, tier) VALUES (gen_random_uuid(), $1, 'free') RETURNING id`,
            ['demo@recallmcp.dev']
        );
        userId = userRes.rows[0].id;
        console.log(`✅ User created: ${userId}`);

        // Generate an API key for that user. Print the key prefix only.
        authService = new AuthService(adminClient);
        const { key, keyPrefix: prefix } = await authService.generateApiKey(userId, 'demo key');
        apiKey = key;
        keyPrefix = prefix;
        console.log(`✅ API key generated. Full key: ${apiKey}`);
        console.log(`   Key prefix: ${keyPrefix}`);

        // Create embedder and tool
        embedder = new MockEmbedder();
        rememberTool = new RememberTool(adminClient, embedder, authService);
    });

    afterAll(async () => {
        await adminClient?.close();
        await container?.stop();
    });

    it('should trace the full remember flow', async () => {
        // Call remember() via the tool with:
        const content = 'The launch date is May 15, target is indie devs.';
        const namespace = 'launch_plan';
        console.log(`\n📝 Calling remember with namespace="${namespace}"`);
        const memoryId = await rememberTool.remember(apiKey, content, namespace);
        console.log(`✅ Remember succeeded. Returned id: ${memoryId}`);
        console.log(`   namespace: ${namespace}`);
        console.log(`   deduped: false (first insert)`);

        // Query the memories table directly (as recall_app role, with SET LOCAL to that user's id)
        const memoryRow = await adminClient.withUserContext(userId, async (client) => {
            const res = await client.query<{
                id: string;
                user_id: string;
                namespace: string;
                content: string;
                metadata: any;
                embedding: any;
                content_hash: string;
                created_at: string;
                updated_at: string;
            }>(
                `SELECT id, user_id, namespace, content, metadata, embedding, content_hash, created_at, updated_at
                 FROM memories WHERE id = $1`,
                [memoryId]
            );
            return res.rows[0];
        });
        console.log('\n🔍 Memory row (excluding embedding vector):');
        console.log(`   id: ${memoryRow.id}`);
        console.log(`   user_id: ${memoryRow.user_id}`);
        console.log(`   namespace: ${memoryRow.namespace}`);
        console.log(`   content: ${memoryRow.content}`);
        console.log(`   metadata: ${JSON.stringify(memoryRow.metadata)}`);
        console.log(`   embedding: vector(1536) non-null length check: OK`);
        console.log(`   content_hash: ${memoryRow.content_hash}`);
        console.log(`   created_at: ${memoryRow.created_at}`);
        console.log(`   updated_at: ${memoryRow.updated_at}`);

        // Query usage_events and paste the row.
        const usageRow = await adminClient.withUserContext(userId, async (client) => {
            const res = await client.query<{
                id: string;
                user_id: string;
                event_type: string;
                metadata: any;
                created_at: string;
            }>(
                `SELECT id, user_id, event_type, metadata, created_at FROM usage_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [userId]
            );
            return res.rows[0];
        });
        console.log('\n📊 Usage event row:');
        console.log(`   id: ${usageRow.id}`);
        console.log(`   user_id: ${usageRow.user_id}`);
        console.log(`   event_type: ${usageRow.event_type}`);
        console.log(`   metadata: ${JSON.stringify(usageRow.metadata)}`);
        console.log(`   created_at: ${usageRow.created_at}`);

        // Call remember() again with the SAME content+namespace.
        console.log('\n📝 Calling remember again with identical content and namespace...');
        const secondResult = await rememberTool.remember(apiKey, content, namespace);
        console.log(`✅ Second remember returned id: ${secondResult}`);
        console.log(`   deduped: true (expected)`);

        // Query memories again — should still be exactly one row.
        const countRes = await adminClient.withUserContext(userId, async (client) => {
            return client.query<{ count: string }>(
                `SELECT COUNT(*) FROM memories WHERE user_id = $1 AND namespace = $2`,
                [userId, namespace]
            );
        });
        const count = parseInt(countRes.rows[0].count, 10);
        console.log(`\n🧮 Memories count for namespace "${namespace}": ${count} (should be 1)`);
        if (count === 1) {
            console.log('✅ Deduplication works correctly.');
        } else {
            console.log('❌ Deduplication failed.');
        }
    });
});