import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseClient } from '../../src/db/client.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { ForgetTool } from '../../src/tools/forget.js';
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
            if (!(err instanceof Error && err.message.includes('already exists'))) {
                throw err;
            }
        }
    }
}

describe('Forget by_query two-step (R5)', () => {
    let container: Awaited<ReturnType<typeof PostgreSqlContainer.prototype.start>>;
    let adminClient: DatabaseClient;
    let embedder: MockEmbedder;
    let forgetTool: ForgetTool;
    let userId: string;

    beforeAll(async () => {
        container = await new PostgreSqlContainer('pgvector/pgvector:pg15')
            .withDatabase('testdb')
            .withUsername('test')
            .withPassword('test')
            .withExposedPorts(5432)
            .start();
        const connectionString = `postgresql://test:test@${container.getHost()}:${container.getPort()}/testdb`;
        adminClient = new DatabaseClient(connectionString);
        await applyMigrations(adminClient);

        embedder = new MockEmbedder();
        forgetTool = new ForgetTool(adminClient, embedder);

        // Create user
        userId = crypto.randomUUID();
        await adminClient.withUserContext(userId, async (client) => {
            await client.query(
                `INSERT INTO users (id, email, tier) VALUES ($1, $2, 'free') ON CONFLICT (id) DO NOTHING`,
                [userId, `forget-test-${Date.now()}@example.com`]
            );
        });

        // Seed test memories across two namespaces
        const contents = [
            { content: 'The sky is blue on a clear day', ns: 'general' },
            { content: 'Grass is green in the spring', ns: 'general' },
            { content: 'The ocean is deep blue', ns: 'general' },
            { content: 'Python is a programming language', ns: 'work' },
            { content: 'JavaScript runs in the browser', ns: 'work' },
        ];
        for (const { content, ns } of contents) {
            const id = crypto.randomUUID();
            const embedding = await embedder.embed(content);
            const vectorLiteral = `[${embedding.vector.join(',')}]`;
            const contentHash = crypto.createHash('sha256').update(content).digest('hex');
            await adminClient.withUserContext(userId, async (client) => {
                await client.query(
                    `INSERT INTO memories (id, user_id, namespace, content, embedding, content_hash)
                     VALUES ($1, $2, $3, $4, $5::vector, $6)`,
                    [id, userId, ns, content, vectorLiteral, contentHash]
                );
            });
        }
    });

    afterAll(async () => {
        await adminClient?.close();
        await container?.stop();
    });

    // ─── Threshold filtering ──────────────────────────────────────────────

    it('should return zero matches with no token when threshold filters everything', async () => {
        const result = await forgetTool.forgetByQueryPreview(userId, 'blue', undefined, 1.5, 10);
        // Above 1.0 threshold — no matches possible
        expect(result.preview).toBe(true);
        expect(result.matches).toHaveLength(0);
        expect(result.total_matches).toBe(0);
        expect(result.confirmation_token).toBe(''); // no token on zero matches
        expect(result.expires_at).toBe('');
    });

    // ─── Namespace scoping ────────────────────────────────────────────────

    it('should only match within a specific namespace', async () => {
        const result = await forgetTool.forgetByQueryPreview(userId, 'language', 'work', 0.0, 10);
        // 'work' namespace has 'Python is a programming language' and 'JavaScript runs in the browser'
        expect(result.matches.length).toBeGreaterThanOrEqual(1);
        expect(result.matches.length).toBeLessThanOrEqual(2);
    });

    // ─── Token rejection ──────────────────────────────────────────────────

    it('should reject wrong confirmation token', async () => {
        await expect(
            forgetTool.forgetByQueryConfirm(userId, crypto.randomBytes(32).toString('hex'))
        ).rejects.toThrowError('Invalid or expired confirmation token');
    });

    it('should reject confirmation token belonging to another user', async () => {
        // Preview as user A — query for 'language' in 'work' namespace
        const preview = await forgetTool.forgetByQueryPreview(userId, 'language', 'work', 0.0, 10);
        expect(preview.matches.length).toBeGreaterThanOrEqual(1);

        // Confirm as a different user (with no prior state)
        const otherUserId = crypto.randomUUID();
        await adminClient.withUserContext(otherUserId, async (client) => {
            await client.query(
                `INSERT INTO users (id, email, tier) VALUES ($1, $2, 'free') ON CONFLICT (id) DO NOTHING`,
                [otherUserId, `other-${Date.now()}@example.com`]
            );
        });

        await expect(
            forgetTool.forgetByQueryConfirm(otherUserId, preview.confirmation_token)
        ).rejects.toThrowError('Invalid or expired confirmation token');
    });

    // ─── Token expiry with fake clock ──────────────────────────────────────

    it('should reject expired confirmation token with distinct error and evict on cleanup', async () => {
        // Step 1: Preview with real timers — get a token
        const preview = await forgetTool.forgetByQueryPreview(userId, 'Python', 'work', 0.0, 10);
        expect(preview.matches.length).toBeGreaterThanOrEqual(1);
        expect(preview.confirmation_token).toBeTruthy();

        // Step 2: Install fake timers set to just past 5 minutes from now
        // The token's expiresAt was set during preview: Date.now() + 300000.
        // Since preview completed successfully, expiresAt < Date.now() + 300000 + some small delta.
        // We advance the fake clock past that expiry point without letting the
        // 60s cleanup interval catch up on the same tick.
        //
        // Cleanup fires every 60s from the interval's schedule. By offsetting
        // the fake clock's base (now - 1) and advancing by 300001, the clock
        // reaches Date.now() + 300000, but the cleanup interval doesn't fire
        // at exactly this offset. We get to the confirm call before cleanup evicts.
        const now = Date.now();
        vi.useFakeTimers({ now: now - 1 });
        vi.advanceTimersByTime(300001);
        // Clock is now at: now - 1 + 300001 = now + 300000
        // This is 300001ms from start, cleanup fires at +60000, +120000, ..., +300000
        // At +300000: Date.now() = now + 299999 (since base is now - 1)
        // expiresAt ≈ (now - epsilon) + 300000 ≈ now + 300000 - epsilon
        // Cleanup checks: expiresAt <= Date.now() → (now + 300000 - epsilon) <= (now + 299999)
        // This is false for any positive epsilon → token NOT evicted by cleanup
        //
        // Now the forgerByQueryConfirm check:
        // pending.expiresAt <= Date.now() → (now + 300000 - epsilon) <= (now + 300000)
        // This is true for any non-negative epsilon → token IS expired

        await expect(
            forgetTool.forgetByQueryConfirm(userId, preview.confirmation_token)
        ).rejects.toThrowError('Confirmation token has expired');

        // Step 3: Advance clock past next cleanup boundary (now + 360000)
        // We go from now + 300000 to now + 360000 (adds 60000ms)
        // This fires the cleanup at +360000 from base (first +360000 tick since the interval
        // already fired at +300000, next is at +360000)
        // At cleanup +360000: Date.now() = now - 1 + 360000 = now + 359999
        // expiresAt ≈ now + 300000 - epsilon
        // Cleanup checks: expiresAt <= Date.now() → now + 300000 - epsilon <= now + 359999
        // This is true → cleanup evicts the entry
        vi.advanceTimersByTime(60000);

        // Now the token should be gone from the Map entirely
        await expect(
            forgetTool.forgetByQueryConfirm(userId, preview.confirmation_token)
        ).rejects.toThrowError('Invalid or expired confirmation token');

        vi.useRealTimers();
    });

    // ─── Happy path (last — deletes data) ────────────────────────────────

    it('should preview matches then confirm deletion (two-step happy path)', async () => {
        // Step 1: Preview — find memories about "blue"
        const preview = await forgetTool.forgetByQueryPreview(userId, 'blue', undefined, 0.0, 10);
        expect(preview.preview).toBe(true);
        expect(preview.matches.length).toBeGreaterThanOrEqual(2);
        expect(preview.confirmation_token).toBeTruthy();
        expect(preview.expires_at).toBeTruthy();
        const previewIds = preview.matches.map(m => m.id);

        // Step 2: Confirm deletion
        const confirm = await forgetTool.forgetByQueryConfirm(userId, preview.confirmation_token);
        expect(confirm.success).toBe(true);
        expect(confirm.deleted_count).toBe(previewIds.length);

        // Verify they're actually gone
        for (const id of previewIds) {
            const res = await adminClient.withUserContext(userId, async (client) => {
                return client.query('SELECT id FROM memories WHERE id = $1', [id]);
            });
            expect(res.rows).toHaveLength(0);
        }
    });
});
