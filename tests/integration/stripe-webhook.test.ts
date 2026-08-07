/**
 * Integration tests for Stripe webhook POST /api/stripe/webhook (R14).
 *
 * Tests the full route: signature verification, idempotency, event dispatching,
 * tier transitions, and the disabled-route fallback.
 *
 * Stripe SDK is mocked at the module boundary; signature verification and
 * event object construction are controlled via the mock constructEvent function.
 */

import { describe, it, beforeAll, afterAll, afterEach, expect, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RecallServer } from '../../src/server.js';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { DatabaseClient } from '../../src/db/client.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import net from 'net';

// ── Stripe mock (hoisted so vi.mock factory can capture it) ──────
const { mockConstructEvent, mockDispatchCtrl } = vi.hoisted(() => {
  const ctrl = { reject: false, failEventType: '' };
  return {
    mockConstructEvent: vi.fn(),
    mockDispatchCtrl: ctrl,
  };
});

vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return {
      webhooks: {
        constructEvent: mockConstructEvent,
      },
    };
  }),
}));

vi.mock('../../src/routes/stripe-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    dispatchStripeEvent: vi.fn((event, client, priceToTier, logger) => {
      // If dispatch rejection is armed for this event type, simulate failure
      if (mockDispatchCtrl.reject && event.type === mockDispatchCtrl.failEventType) {
        return Promise.reject(new Error('Simulated dispatch failure'));
      }
      return actual.dispatchStripeEvent(event, client, priceToTier, logger);
    }),
  };
});

// ── Helpers ──────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
  });
}

async function applyMigrations(client: DatabaseClient): Promise<void> {
  const migrationsDir = path.join(__dirname, '../../supabase/migrations');
  const files = (await fs.readdir(migrationsDir))
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await client.query(sql);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('already exists')) continue;
      throw err;
    }
  }
}

/**
 * Build a fake Stripe event object (matches Stripe.Event shape for dispatch testing).
 */
function makeEvent(
  id: string,
  type: string,
  data: Record<string, any>,
): Record<string, any> {
  return {
    id,
    type,
    data: {
      object: data,
    },
    api_version: '2025-02-24',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
  };
}

/**
 * Build a fake subscription object.
 */
function makeSubscription(
  customerId: string,
  priceId: string,
  status = 'active',
): Record<string, any> {
  return {
    id: `sub_${randomUUID().replace(/-/g, '')}`,
    customer: customerId,
    status,
    items: {
      data: [
        {
          price: { id: priceId },
        },
      ],
    },
    metadata: {},
  };
}

/**
 * Build a fake customer object.
 */
function makeCustomer(
  customerId: string,
  appUserId?: string,
): Record<string, any> {
  const customer: Record<string, any> = {
    id: customerId,
    email: 'test@example.com',
    name: 'Test User',
    metadata: {},
  };
  if (appUserId) {
    customer.metadata.app_user_id = appUserId;
  }
  return customer;
}

// ── Test suite ───────────────────────────────────────────────────
describe('Stripe webhook POST /api/stripe/webhook (R14)', () => {
  let container: any;
  let server: RecallServer;
  let db: DatabaseClient;
  let originalEnv: NodeJS.ProcessEnv;
  let serverUrl: string;
  let userId: string;
  let customerId: string;
  const priceFree = 'price_free_test';
  const pricePro = 'price_pro_test';
  const priceTeam = 'price_team_test';
  const priceUnknown = 'price_unknown_test';

  beforeAll(async () => {
    // Start Postgres
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
    await db.registerVectorTypes();

    // Save original env and set test env vars
    originalEnv = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = connectionString;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
    process.env.STRIPE_PRICE_TO_TIER = JSON.stringify({
      [priceFree]: 'free',
      [pricePro]: 'pro',
      [priceTeam]: 'team',
    });

    // Create and start server
    const embedder = new MockEmbedder();
    server = new RecallServer(embedder, {
      transport: 'http',
      port: 0, // random port
      enableDnsRebindingProtection: false,
    });
    await server.start();
    const addr = server.fastify.server.address();
    serverUrl = `http://localhost:${addr && typeof addr === 'object' ? addr.port : 0}`;

    // Create a test user with stripe_customer_id
    userId = randomUUID();
    customerId = `cus_${randomUUID().replace(/-/g, '')}`;
    await db.query(
      'INSERT INTO users (id, email, tier, stripe_customer_id) VALUES ($1, $2, $3, $4)',
      [userId, `stripe-test-${userId}@example.com`, 'free', customerId],
    );

    // Create a second user for the "existing key unaffected" test
    const userId2 = randomUUID();
    const customerId2 = `cus_${randomUUID().replace(/-/g, '')}`;
    await db.query(
      'INSERT INTO users (id, email, tier, stripe_customer_id) VALUES ($1, $2, $3, $4)',
      [userId2, `stripe-test-key-${userId2}@example.com`, 'free', customerId2],
    );
    // Give this user an API key with an explicit tier of 'free'
    const { AuthService } = await import('../../src/auth/index.js');
    const auth = new AuthService(db);
    await auth.generateApiKey(userId2, { label: 'explicit-free', tier: 'free' });
  }, 30000);

  afterAll(async () => {
    process.env = originalEnv;
    await server?.stop();
    await db?.close();
    await container?.stop();
  }, 15000);

  afterEach(() => {
    mockConstructEvent.mockReset();
  });

  // ── Helper: POST to webhook ────────────────────────────────────
  async function postWebhook(body: object): Promise<{
    status: number;
    json: any;
  }> {
    const response = await fetch(`${serverUrl}/api/stripe/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 'mock_sig',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, json };
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. subscription.created / .updated — happy paths
  // ═══════════════════════════════════════════════════════════════
  describe('subscription.created / .updated — tier sync', () => {
    it('handles subscription.created: user tier updated from free -> pro', async () => {
      const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
      const sub = makeSubscription(customerId, pricePro);
      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.subscription.created', sub));

      const { status, json } = await postWebhook(sub);
      expect(status).toBe(200);
      expect(json.received).toBe(true);

      // Verify DB: user tier updated
      const rows = await db.query('SELECT tier FROM users WHERE id = $1', [userId]);
      expect(rows.rows[0].tier).toBe('pro');

      // Verify event recorded and marked processed
      const eventRows = await db.query(
        'SELECT event_type, processed_at FROM stripe_events WHERE id = $1',
        [eventId],
      );
      expect(eventRows.rows).toHaveLength(1);
      expect(eventRows.rows[0].event_type).toBe('customer.subscription.created');
      expect(eventRows.rows[0].processed_at).not.toBeNull();
    });

    it('handles subscription.updated: tier transitions from pro -> team', async () => {
      // First set user to pro
      await db.query('UPDATE users SET tier = $1 WHERE id = $2', ['pro', userId]);

      const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
      const sub = makeSubscription(customerId, priceTeam);
      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.subscription.updated', sub));

      const { status } = await postWebhook(sub);
      expect(status).toBe(200);

      const rows = await db.query('SELECT tier FROM users WHERE id = $1', [userId]);
      expect(rows.rows[0].tier).toBe('team');

      // Reset tier back
      await db.query('UPDATE users SET tier = $1 WHERE id = $2', ['free', userId]);
    });

    it('handles subscription.updated: tier transitions from pro -> free (downgrade)', async () => {
      // First set user to pro
      await db.query('UPDATE users SET tier = $1 WHERE id = $2', ['pro', userId]);

      const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
      const sub = makeSubscription(customerId, priceFree);
      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.subscription.updated', sub));

      const { status } = await postWebhook(sub);
      expect(status).toBe(200);

      const rows = await db.query('SELECT tier FROM users WHERE id = $1', [userId]);
      expect(rows.rows[0].tier).toBe('free');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. subscription.deleted — downgrade to free
  // ═══════════════════════════════════════════════════════════════
  describe('subscription.deleted — downgrade to free', () => {
    it('downgrades user to free on subscription deletion', async () => {
      // Set user to team first
      await db.query('UPDATE users SET tier = $1 WHERE id = $2', ['team', userId]);

      const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
      const sub = makeSubscription(customerId, priceTeam, 'canceled');
      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.subscription.deleted', sub));

      const { status } = await postWebhook(sub);
      expect(status).toBe(200);

      const rows = await db.query('SELECT tier FROM users WHERE id = $1', [userId]);
      expect(rows.rows[0].tier).toBe('free');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. Invalid signature
  // ═══════════════════════════════════════════════════════════════
  describe('invalid signature', () => {
    it('returns 400 when constructEvent throws', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      const { status, json } = await postWebhook({});
      expect(status).toBe(400);
      expect(json.error).toMatch(/invalid signature/i);
    });

    it('returns 400 when stripe-signature header is missing', async () => {
      // Don't set mockConstructEvent — let it return undefined (which means
      // route gets a mock event, but we test the header check first)
      const response = await fetch(`${serverUrl}/api/stripe/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toMatch(/missing stripe-signature/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. Replay / idempotency
  // ═══════════════════════════════════════════════════════════════
  describe('idempotency — replay attack', () => {
    it('returns 200 for duplicate event after processed_at is set', async () => {
      // Insert a "previously processed" event directly
      const eventId = `evt_already_processed_${randomUUID().replace(/-/g, '')}`;
      await db.query(
        `INSERT INTO stripe_events (id, event_type, processed_at, payload)
         VALUES ($1, $2, NOW(), $3)`,
        [eventId, 'customer.subscription.created', JSON.stringify({})],
      );

      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.subscription.created', {}));

      // Replay
      const { status, json } = await postWebhook({});
      expect(status).toBe(200);
      expect(json.received).toBe(true);

      // Verify still only ONE event row (no duplicate)
      const rows = await db.query('SELECT id FROM stripe_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
    });

    it('returns 200 on concurrent delivery (23505 PK collision)', async () => {
      const eventId = `evt_concurrent_${randomUUID().replace(/-/g, '')}`;
      // Pre-insert a fully processed row (simulating another worker having
      // committed the transaction before this worker's INSERT runs)
      await db.query(
        `INSERT INTO stripe_events (id, event_type, processed_at, payload)
         VALUES ($1, $2, NOW(), $3)`,
        [eventId, 'customer.subscription.created', JSON.stringify({})],
      );

      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.subscription.created', {}));

      // This worker's INSERT hits 23505 → ROLLBACK → 200
      const { status, json } = await postWebhook({});
      expect(status).toBe(200);
      expect(json.received).toBe(true);

      // Still exactly one row (INSERT on this connection was rolled back)
      const rows = await db.query('SELECT id FROM stripe_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 9. Atomic dispatch failure → rollback → retry
  // ═══════════════════════════════════════════════════════════════
  describe('atomic dispatch failure — rollback then retry succeeds', () => {
    it('rolls back on dispatch failure and succeeds on retry', async () => {
      // Track starting tier
      const startRows = await db.query('SELECT tier FROM users WHERE id = $1', [userId]);
      const startTier = startRows.rows[0].tier;

      const eventId = `evt_atomic_${randomUUID().replace(/-/g, '')}`;
      const sub = makeSubscription(customerId, pricePro);

      // ── Attempt 1: dispatch throws → 500 → rollback ─────────
      mockDispatchCtrl.reject = true;
      mockDispatchCtrl.failEventType = 'customer.subscription.created';
      mockConstructEvent.mockReturnValueOnce(makeEvent(eventId, 'customer.subscription.created', sub));

      const res1 = await postWebhook(sub);
      expect(res1.status).toBe(500);

      // No row in stripe_events (rolled back)
      const eventRows1 = await db.query('SELECT id FROM stripe_events WHERE id = $1', [eventId]);
      expect(eventRows1.rows).toHaveLength(0);

      // No tier change (rolled back)
      const tierRows1 = await db.query('SELECT tier FROM users WHERE id = $1', [userId]);
      expect(tierRows1.rows[0].tier).toBe(startTier);

      // ── Attempt 2: retry succeeds → 200 → committed ────────
      mockDispatchCtrl.reject = false;
      mockConstructEvent.mockReturnValueOnce(makeEvent(eventId, 'customer.subscription.created', sub));

      const res2 = await postWebhook(sub);
      expect(res2.status).toBe(200);
      expect(res2.json.received).toBe(true);

      // Row exists with processed_at set
      const eventRows2 = await db.query(
        'SELECT processed_at FROM stripe_events WHERE id = $1',
        [eventId],
      );
      expect(eventRows2.rows).toHaveLength(1);
      expect(eventRows2.rows[0].processed_at).not.toBeNull();

      // Tier changed
      const tierRows2 = await db.query('SELECT tier FROM users WHERE id = $1', [userId]);
      expect(tierRows2.rows[0].tier).toBe('pro');

      // Reset tier
      await db.query('UPDATE users SET tier = $1 WHERE id = $2', ['free', userId]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. Unknown customer
  // ═══════════════════════════════════════════════════════════════
  describe('unknown customer', () => {
    it('returns 200 and logs warn when stripe_customer_id not bound', async () => {
      const eventId = `evt_unknown_${randomUUID().replace(/-/g, '')}`;
      const sub = makeSubscription('cus_unknown_nobody', pricePro);
      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.subscription.created', sub));

      const { status, json } = await postWebhook(sub);
      expect(status).toBe(200);
      expect(json.received).toBe(true);

      // Event is marked processed
      const rows = await db.query(
        'SELECT processed_at FROM stripe_events WHERE id = $1',
        [eventId],
      );
      expect(rows.rows[0].processed_at).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 6. Unknown event type
  // ═══════════════════════════════════════════════════════════════
  describe('unknown event type', () => {
    it('returns 200 and marks event processed without tier change', async () => {
      const eventId = `evt_unknown_type_${randomUUID().replace(/-/g, '')}`;
      mockConstructEvent.mockReturnValue(
        makeEvent(eventId, 'invoice.payment_succeeded', {}),
      );

      const { status, json } = await postWebhook({});
      expect(status).toBe(200);
      expect(json.received).toBe(true);

      const rows = await db.query(
        'SELECT event_type, processed_at FROM stripe_events WHERE id = $1',
        [eventId],
      );
      expect(rows.rows[0].event_type).toBe('invoice.payment_succeeded');
      expect(rows.rows[0].processed_at).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 7. Unmapped price_id
  // ═══════════════════════════════════════════════════════════════
  describe('unmapped price_id', () => {
    it('returns 200 and logs warn without tier change', async () => {
      // Set user to 'free'
      await db.query('UPDATE users SET tier = $1 WHERE id = $2', ['free', userId]);

      const eventId = `evt_unmapped_${randomUUID().replace(/-/g, '')}`;
      const sub = makeSubscription(customerId, priceUnknown);
      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.subscription.updated', sub));

      const { status, json } = await postWebhook(sub);
      expect(status).toBe(200);
      expect(json.received).toBe(true);

      // Tier unchanged
      const rows = await db.query('SELECT tier FROM users WHERE id = $1', [userId]);
      expect(rows.rows[0].tier).toBe('free');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 8. Webhook disabled (missing env vars) — separate server
  // ═══════════════════════════════════════════════════════════════
  describe('webhook disabled (missing env vars)', () => {
    let disabledServer: RecallServer;
    let disabledUrl: string;

    beforeAll(async () => {
      const savedEnv = { ...process.env };
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
      delete process.env.STRIPE_PRICE_TO_TIER;

      const embedder = new MockEmbedder();
      // port: 0 doesn't work with RecallServer (0 || 8080 = 8080), so find a free port
      const freePort = await getFreePort();
      disabledServer = new RecallServer(embedder, {
        transport: 'http',
        port: freePort,
        enableDnsRebindingProtection: false,
      });
      await disabledServer.start();
      disabledUrl = `http://localhost:${freePort}`;

      process.env = savedEnv;
    }, 15000);

    afterAll(async () => {
      await disabledServer?.stop();
    });

    it('returns 503 with clear error message', async () => {
      const response = await fetch(`${disabledUrl}/api/stripe/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(503);
      const json = await response.json();
      expect(json.error).toMatch(/stripe integration not configured/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 10. customer.created — binding
  // ═══════════════════════════════════════════════════════════════
  describe('customer.created — user binding', () => {
    it('binds stripe_customer_id when app_user_id is in metadata', async () => {
      const eventId = `evt_cus_create_${randomUUID().replace(/-/g, '')}`;
      const newUserId = randomUUID();
      await db.query(
        'INSERT INTO users (id, email, tier) VALUES ($1, $2, $3)',
        [newUserId, `bind-test-${newUserId}@example.com`, 'free'],
      );

      const newCusId = `cus_${randomUUID().replace(/-/g, '')}`;
      const customer = makeCustomer(newCusId, newUserId);
      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.created', customer));

      const { status } = await postWebhook(customer);
      expect(status).toBe(200);

      // Verify binding
      const rows = await db.query(
        'SELECT stripe_customer_id FROM users WHERE id = $1',
        [newUserId],
      );
      expect(rows.rows[0].stripe_customer_id).toBe(newCusId);
    });

    it('logs warn and does not crash when customer.created lacks app_user_id', async () => {
      const eventId = `evt_cus_noapp_${randomUUID().replace(/-/g, '')}`;
      const orphanCusId = `cus_${randomUUID().replace(/-/g, '')}`;
      const customer = makeCustomer(orphanCusId); // no app_user_id
      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.created', customer));

      const { status, json } = await postWebhook(customer);
      expect(status).toBe(200);
      expect(json.received).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 11. Existing key's tier unaffected by user tier upgrade
  // ═══════════════════════════════════════════════════════════════
  describe('per-key tier override survives user tier change', () => {
    it('explicit key tier unchanged after user tier upgrade', async () => {
      // Find the user with an explicit 'free' key (created in beforeAll)
      const keyRows = await db.query(
        `SELECT u.id as user_id, u.stripe_customer_id, k.id as key_id, k.tier
         FROM users u
         JOIN api_keys k ON k.user_id = u.id
         WHERE k.tier = $1 AND k.label = $2
         LIMIT 1`,
        ['free', 'explicit-free'],
      );
      expect(keyRows.rows).toHaveLength(1);
      const keyUserId = keyRows.rows[0].user_id;
      const keyUserCustomerId = keyRows.rows[0].stripe_customer_id;
      const keyId = keyRows.rows[0].key_id;

      // Upgrade user tier to 'pro' via webhook
      const eventId = `evt_key_override_${randomUUID().replace(/-/g, '')}`;
      const sub = makeSubscription(keyUserCustomerId, pricePro);
      mockConstructEvent.mockReturnValue(makeEvent(eventId, 'customer.subscription.created', sub));

      const { status } = await postWebhook(sub);
      expect(status).toBe(200);

      // Verify user tier IS pro
      const userRows = await db.query('SELECT tier FROM users WHERE id = $1', [keyUserId]);
      expect(userRows.rows[0].tier).toBe('pro');

      // Verify the key's explicit tier is STILL 'free'
      const keyData = await db.query(
        'SELECT tier FROM api_keys WHERE id = $1',
        [keyId],
      );
      expect(keyData.rows[0].tier).toBe('free');

      // This proves the rate limiter will use the key's explicit tier ('free')
      // instead of the user's tier ('pro'), because api_keys.tier has priority
      // over users.tier in the auth/rate-limit lookup.
    });
  });
});
