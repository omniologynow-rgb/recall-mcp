/**
 * Stripe event dispatch functions.
 *
 * Separated from the route handler so tests can mock dispatch
 * behavior (e.g., simulate dispatch failure for atomicity tests).
 */

import Stripe from 'stripe';
import type { PoolClient } from 'pg';
import type pino from 'pino';

// ── Event dispatcher ─────────────────────────────────────────────
export async function dispatchStripeEvent(
  event: Stripe.Event,
  client: PoolClient,
  priceToTier: Record<string, string>,
  logger: pino.Logger,
): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      await handleSubscriptionChange(sub, client, priceToTier, logger);
      return;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await handleSubscriptionDeleted(sub, client, logger);
      return;
    }

    case 'customer.created': {
      const customer = event.data.object as Stripe.Customer;
      await handleCustomerCreated(customer, client, logger);
      return;
    }

    default:
      logger.info(
        { eventType: event.type, eventId: event.id },
        'Stripe webhook: unhandled event type (logged and skipped)',
      );
  }
}

// ── Event handlers ───────────────────────────────────────────────
async function handleSubscriptionChange(
  subscription: Stripe.Subscription,
  client: PoolClient,
  priceToTier: Record<string, string>,
  logger: pino.Logger,
): Promise<void> {
  const customerId = subscription.customer as string;

  // Determine tier from the first subscription item's price
  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (!priceId) {
    logger.warn({ eventId: subscription.id, customerId }, 'No price ID in subscription');
    return;
  }

  const newTier = priceToTier[priceId];
  if (!newTier) {
    logger.warn(
      { eventId: subscription.id, customerId, priceId },
      'Unmapped price ID in subscription — tier unchanged',
    );
    return;
  }

  // Find user by stripe_customer_id
  const userResult = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE stripe_customer_id = $1',
    [customerId],
  );

  if (userResult.rows.length === 0) {
    logger.warn(
      { eventId: subscription.id, customerId },
      'Unknown customer ID — no user bound to this Stripe customer',
    );
    return;
  }

  const userId = userResult.rows[0].id;
  await client.query('UPDATE users SET tier = $1 WHERE id = $2', [newTier, userId]);
  logger.info({ userId, customerId, newTier }, 'User tier updated via Stripe subscription');
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  client: PoolClient,
  logger: pino.Logger,
): Promise<void> {
  const customerId = subscription.customer as string;

  const userResult = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE stripe_customer_id = $1',
    [customerId],
  );

  if (userResult.rows.length === 0) {
    logger.warn(
      { eventId: subscription.id, customerId },
      'Unknown customer ID on subscription deletion',
    );
    return;
  }

  const userId = userResult.rows[0].id;
  await client.query('UPDATE users SET tier = $1 WHERE id = $2', ['free', userId]);
  logger.info({ userId, customerId }, 'User downgraded to free on subscription deletion');
}

async function handleCustomerCreated(
  customer: Stripe.Customer,
  client: PoolClient,
  logger: pino.Logger,
): Promise<void> {
  const appUserId = customer.metadata?.app_user_id;
  if (appUserId) {
    try {
      await client.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customer.id, appUserId],
      );
      logger.info({ appUserId, stripeCustomerId: customer.id }, 'Stripe customer bound to user');
    } catch (err) {
      logger.error(
        { err, appUserId, stripeCustomerId: customer.id },
        'Failed to bind Stripe customer to user',
      );
    }
  } else {
    logger.warn(
      { customerId: customer.id },
      'customer.created without app_user_id metadata — manual binding required',
    );
  }
}
