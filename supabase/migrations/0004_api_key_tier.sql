-- Add per-API-key tier column for rate limiting
-- Allows each API key to have its own tier, enabling granular rate limits
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'free';

-- Ensure tier values are valid
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_tier_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_tier_check CHECK (tier IN ('free', 'starter', 'pro', 'team'));
