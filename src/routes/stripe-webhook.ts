/**
 * Stripe webhook route — POST /api/stripe/webhook
 *
 * Processes Stripe billing events to sync user tiers:
 *   - customer.subscription.created / .updated     → tier upgrade/downgrade
 *   - customer.subscription.deleted                 → downgrade to 'free'
 *   - customer.created                              → bind stripe_customer_id (via metadata.app_user_id)
 *   - other event types                             → logged and skipped
 *
 * Idempotent via stripe_events table (PK = Stripe event ID).
 * Signature-verified via Stripe SDK (constructEvent).
 * Disabled (503) when STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_TO_TIER
 * are missing at startup.
 */

import Stripe from 'stripe';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseClient } from '../db/client.js';
import type pino from 'pino';
import { dispatchStripeEvent } from './stripe-dispatch.js';

// ── Types ────────────────────────────────────────────────────────
const VALID_TIERS = ['free', 'starter', 'pro', 'team'] as const;

export interface StripeWebhookOptions {
  db: DatabaseClient;
  logger: pino.Logger;
  rawBodyStore: WeakMap<object, Buffer>;
}

// ── Route registration ───────────────────────────────────────────
export function registerStripeWebhook(
  fastify: FastifyInstance,
  options: StripeWebhookOptions,
): void {
  const { db, logger, rawBodyStore } = options;

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const priceToTierRaw = process.env.STRIPE_PRICE_TO_TIER;

  // ── Graceful disable when env vars are missing ────────────────
  if (!stripeSecretKey || !stripeWebhookSecret || !priceToTierRaw) {
    fastify.post('/api/stripe/webhook', async (_request, reply) => {
      return reply.status(503).send({ error: 'Stripe integration not configured' });
    });
    logger.warn('Stripe webhook disabled: missing STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, or STRIPE_PRICE_TO_TIER');
    return;
  }

  // ── Parse price-to-tier mapping ───────────────────────────────
  let priceToTier: Record<string, string>;
  try {
    priceToTier = JSON.parse(priceToTierRaw);
    for (const [priceId, tier] of Object.entries(priceToTier)) {
      if (!(VALID_TIERS as readonly string[]).includes(tier as string)) {
        logger.warn({ priceId, tier }, 'Invalid tier value in STRIPE_PRICE_TO_TIER — must be free|starter|pro|team');
      }
    }
  } catch {
    logger.warn('Invalid STRIPE_PRICE_TO_TIER JSON — disabling Stripe webhook');
    fastify.post('/api/stripe/webhook', async (_request, reply) => {
      return reply.status(503).send({ error: 'Stripe integration not configured' });
    });
    return;
  }

  // ── Initialize Stripe SDK ─────────────────────────────────────
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2025-02-24' as any });

  // ── Route handler ──────────────────────────────────────────────
  fastify.post('/api/stripe/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Get raw body (needed for signature verification)
    const rawBody = rawBodyStore.get(request as object);
    if (!rawBody) {
      return reply.status(400).send({ error: 'Missing request body' });
    }

    // 2. Get signature header
    const signature = request.headers['stripe-signature'] as string;
    if (!signature) {
      return reply.status(400).send({ error: 'Missing stripe-signature header' });
    }

    // 3. Verify signature via Stripe SDK
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
    } catch (err) {
      logger.warn({ err }, 'Stripe webhook: invalid signature');
      return reply.status(400).send({ error: 'Invalid signature' });
    }

    // 4. Acquire a dedicated client for the transaction
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // 5. Insert event record — this is now inside the transaction
      try {
        await client.query(
          `INSERT INTO stripe_events (id, event_type, payload) VALUES ($1, $2, $3)`,
          [event.id, event.type, JSON.stringify(event)],
        );
      } catch (err: any) {
        if (err.code === '23505') {
          // Concurrent delivery — another worker already committed this event.
          // The INSERT failed so there's nothing to ROLLBACK (no rows written
          // on this connection), but we issued BEGIN, so close the empty txn.
          await client.query('ROLLBACK');
          return reply.status(200).send({ received: true });
        }
        throw err;
      }

      // 6. Dispatch by event type (all queries use the transaction client)
      await dispatchStripeEvent(event, client, priceToTier, logger);

      // 7. Mark processed and commit atomically
      await client.query(
        'UPDATE stripe_events SET processed_at = NOW() WHERE id = $1',
        [event.id],
      );
      await client.query('COMMIT');
      return reply.status(200).send({ received: true });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, eventId: event.id }, 'Stripe webhook: processing failed');
      return reply.status(500).send({ error: 'Processing error' });
    } finally {
      client.release();
    }
  });

  logger.info('Stripe webhook registered at POST /api/stripe/webhook');
}
