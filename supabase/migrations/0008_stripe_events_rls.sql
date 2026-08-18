-- Migration 0008: enable RLS on stripe_events (Supabase security scan,
-- 2026-08-17: rls_disabled_in_public — the table was reachable with the
-- anon key via PostgREST: full CRUD, though it held 0 rows at the time).
--
-- stripe_events is SYSTEM data (webhook idempotency), not user-scoped:
--   - RLS enabled + FORCED (parity with every other table, mig 0002)
--   - recall_app gets an explicit full-access policy (the webhook writer)
--   - anon/authenticated lose ALL privileges — nothing via the project URL
--   - postgres (owner) + service_role carry BYPASSRLS and are unaffected
--
-- Defense in depth: future tables created by postgres no longer default-
-- grant to anon/authenticated, so the next migration cannot repeat this.

-- Up
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stripe_events_app_access ON stripe_events;
CREATE POLICY stripe_events_app_access ON stripe_events
  FOR ALL TO recall_app USING (true) WITH CHECK (true);

REVOKE ALL ON stripe_events FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

-- Down (reversible)
-- ALTER TABLE stripe_events NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE stripe_events DISABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS stripe_events_app_access ON stripe_events;
