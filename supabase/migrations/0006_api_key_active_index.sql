-- Partial index for the common "list active keys for a user" query
CREATE INDEX IF NOT EXISTS idx_api_keys_user_active ON api_keys(user_id) WHERE revoked_at IS NULL;
