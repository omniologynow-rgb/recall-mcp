-- Usage events table for billing, abuse detection, and product analytics
--
-- IMPORTANT: This migration intentionally uses DROP TABLE IF EXISTS CASCADE
-- followed by CREATE TABLE (not CREATE TABLE IF NOT EXISTS) because of a
-- known pg.Client multi-statement query behavior: CREATE TABLE IF NOT EXISTS
-- followed by ALTER TABLE / CREATE INDEX referencing the new table's columns
-- can fail with "column does not exist" errors within the same query() call.
-- Since this table is new in R9, there is no production data to lose.
-- Production migrations apply exactly once; development containers start fresh.
DROP TABLE IF EXISTS usage_events CASCADE;

CREATE TABLE usage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    api_key_id UUID NOT NULL,
    request_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tokens_consumed INTEGER NOT NULL DEFAULT 1 CHECK (tokens_consumed >= 0),
    latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
    success BOOLEAN NOT NULL,
    error_code TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Foreign keys
ALTER TABLE usage_events ADD CONSTRAINT usage_events_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE usage_events ADD CONSTRAINT usage_events_api_key_id_fkey
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id);

-- Query patterns: per-user timeline, per-api-key timeline
CREATE INDEX idx_usage_events_user_occurred ON usage_events(user_id, occurred_at DESC);
CREATE INDEX idx_usage_events_api_key_occurred ON usage_events(api_key_id, occurred_at DESC);

-- Enable RLS (with FORCE, so even table owner cannot bypass policy)
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;

-- RLS policy
DROP POLICY IF EXISTS usage_events_user_isolation ON usage_events;
CREATE POLICY usage_events_user_isolation ON usage_events
    FOR ALL
    USING (user_id = current_setting('app.current_user_id', true)::uuid);
