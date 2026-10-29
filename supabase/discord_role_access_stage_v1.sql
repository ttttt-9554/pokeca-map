-- Stage 1 / inactive: Discord role verification cache and RLS helper.
-- This migration intentionally DOES NOT alter existing public-data policies.
-- Enforce role access only after origin/data migration and role IDs are ready.
CREATE TABLE IF NOT EXISTS public.discord_role_access_v1 (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  valid_until timestamptz NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.discord_role_access_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discord_role_access_v1 FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.discord_role_access_v1 TO service_role;

CREATE OR REPLACE FUNCTION public.discord_role_allowed_v1()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.discord_role_access_v1 a
    WHERE a.user_id=(SELECT auth.uid()) AND a.valid_until>now()
  );
$$;
REVOKE ALL ON FUNCTION public.discord_role_allowed_v1() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.discord_role_allowed_v1() TO authenticated;
