-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Users table (mirrors billing tier)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('free','starter','pro','team')) DEFAULT 'free',
    stripe_customer_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- API keys (hashed)
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    label TEXT,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Memories (user content with embeddings)
CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL DEFAULT 'default',
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    embedding vector(1536) NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Usage events (for observability)
CREATE TABLE usage_events (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('remember','recall','list','update','forget')),
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for memories
CREATE INDEX idx_memories_user_namespace_created ON memories (user_id, namespace, created_at DESC);
CREATE INDEX idx_memories_user_content_hash ON memories (user_id, content_hash);
CREATE INDEX idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);

-- Index for usage events
CREATE INDEX idx_usage_events_user_created ON usage_events (user_id, created_at DESC);

-- Enable Row-Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

-- RLS policies
-- We use a custom function current_app_user_id() that reads the session variable 'app.current_user_id'.
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS UUID AS $$
    SELECT current_setting('app.current_user_id', false)::UUID;
$$ LANGUAGE sql STABLE;

-- Now create policies that use this function.
-- For users table: allow select only if id matches current app user.
CREATE POLICY "Users can only view own user row" ON users FOR ALL USING (id = current_app_user_id());

-- For api_keys: allow select/update only if user_id matches.
CREATE POLICY "Users can only manage own API keys" ON api_keys FOR ALL USING (user_id = current_app_user_id());

-- For memories: allow select/insert/update/delete only if user_id matches.
CREATE POLICY "Users can only manage own memories" ON memories FOR ALL USING (user_id = current_app_user_id());

-- For usage_events: allow select/insert only if user_id matches.
CREATE POLICY "Users can only see own usage events" ON usage_events FOR ALL USING (user_id = current_app_user_id());

-- Ensure the setting can be set by the app role.
-- The application must connect as a role that does NOT have BYPASSRLS and must set app.current_user_id before any user-scoped query.

-- Create a trigger to update updated_at on memories
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_memories_updated_at BEFORE UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();