-- Migration 0007: Stripe integration
-- Adds stripe_customer_id to users and creates stripe_events table for webhook idempotency.

-- Up
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_unprocessed
  ON stripe_events(received_at)
  WHERE processed_at IS NULL;

-- Down (reversible)
-- DROP TABLE IF EXISTS stripe_events;
-- ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;
