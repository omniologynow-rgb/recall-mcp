-- Force RLS on all tables, even for table owners (belt and suspenders)
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;

-- Create a dedicated application role that does NOT have BYPASSRLS
-- This role will be used by the RecallMCP server to connect to the database.
-- The role must have appropriate permissions to perform CRUD on the tables.
-- We assume the migration is run as a superuser (postgres).
CREATE ROLE recall_app NOLOGIN NOBYPASSRLS;

-- Grant usage on the schema (public) and necessary table permissions
GRANT USAGE ON SCHEMA public TO recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_events TO recall_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO recall_app;

-- Ensure future tables also inherit these grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO recall_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT USAGE, SELECT ON SEQUENCES TO recall_app;

-- Note: The actual database user will be created by the hosting environment (Supabase).
-- In Supabase, the 'authenticated' role already exists and is not a superuser.
-- We'll rely on Supabase's 'authenticated' role (which does not have BYPASSRLS).
-- For local development, ensure DATABASE_URL uses a non‑superuser user.
-- If using the default 'postgres' user (superuser) locally, RLS will be bypassed
-- unless FORCE ROW LEVEL SECURITY is applied (we already did).