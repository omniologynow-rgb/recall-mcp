-- Force RLS on all tables, even for table owners (belt and suspenders)
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;

-- Create a dedicated application role that does NOT have BYPASSRLS
-- This role will be used by the RecallMCP server to connect to the database.
-- The role must have appropriate permissions to perform CRUD on the tables.
-- We assume the migration is run as a superuser (postgres).
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'recall_app') THEN
        CREATE ROLE recall_app NOLOGIN;
    END IF;
END
$$;

-- Grant usage on the schema (public) and necessary table permissions
GRANT USAGE ON SCHEMA public TO recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_events TO recall_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO recall_app;

-- Create a login role that inherits recall_app (for local testing and production)
-- The actual database user will be created by the hosting environment (Supabase).
-- In Supabase, the 'authenticated' role already exists and is not a superuser.
-- We'll rely on Supabase's 'authenticated' role (which does not have BYPASSRLS).
-- For local development, we can create a user that maps to 'authenticated'.
-- However, Supabase's local `supabase start` uses 'authenticated' as a role.
-- We'll assume the connection string uses a user that is NOT a superuser.
-- If using the default 'postgres' user (superuser) locally, RLS will be bypassed.
-- We must ensure the app's DATABASE_URL uses a non‑superuser user.
-- This migration does not create a login user; that is environment‑specific.

-- Add a test policy to verify RLS is enforced even without SET LOCAL
-- If app.current_user_id is NULL, the function current_app_user_id() will throw.
-- That's fine; we want queries to fail unless the variable is set.
-- We'll add a safety comment: the application MUST set app.current_user_id before any user‑scoped query.