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
-- Users: users can see only their own row (based on JWT? We'll use application-level auth; still add policy)
CREATE POLICY "Users can only view own row" ON users FOR ALL USING (id = current_user_id());
-- For simplicity, we'll rely on application-level auth; but we need a function to get current user ID from request context.
-- Since we're using API keys, we cannot use Supabase's auth. We'll set `security definer` functions or use app-level WHERE clauses.
-- We'll still create policies that assume a `current_user_id` function returning UUID.
-- Let's create a helper function that returns the user_id from the JWT claim (if using Supabase Auth). But we're not.
-- Instead, we'll create a policy that always returns false, forcing all queries to go through app-level WHERE clauses.
-- This is a safety net: if app forgets WHERE user_id = ?, RLS will block all rows.
-- We'll set policy to `USING (false)` and `WITH CHECK (false)` for all operations, then allow the service role (bypass RLS).
-- We'll rely on service role for all queries. However spec says RLS must be enabled with policies that scope to user_id.
-- Let's implement a policy that uses a custom claim 'user_id' set by our app via `SET LOCAL`.
-- We'll create a function `current_app_user_id()` that returns UUID from `app.current_user_id` setting.
-- We'll set this in a transaction before each query.

CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS UUID AS $$
    SELECT current_setting('app.current_user_id', true)::UUID;
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
-- We'll also need to grant permissions to the service role (postgres) to bypass RLS? Actually service role will still be subject to RLS.
-- We'll create a role `service_role` (already exists in Supabase) and allow it to bypass RLS via `BYPASSRLS` attribute.
-- In Supabase, the `service_role` already has BYPASSRLS. We'll use that for migrations and admin queries.
-- Our application will connect as `service_role` and set `app.current_user_id` before each user-scoped query.

-- Create a trigger to update updated_at on memories
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_memories_updated_at BEFORE UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();