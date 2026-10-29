-- v21.138: Remember approved Discord logins for up to fourteen days.
-- This is a server-only record keyed to a Supabase Auth session UUID.
-- Avoid FK to auth.sessions: the token hook runs during Auth transactions.
CREATE TABLE IF NOT EXISTS public.discord_remembered_sessions_v1 (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  authorized_until timestamptz NOT NULL
);
ALTER TABLE public.discord_remembered_sessions_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discord_remembered_sessions_v1
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.discord_remembered_sessions_v1
  TO service_role;
CREATE INDEX IF NOT EXISTS discord_remembered_sessions_user_idx
  ON public.discord_remembered_sessions_v1 (user_id, authorized_until);
