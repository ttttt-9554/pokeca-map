-- Login state comes from the existing Auth sessions and role approvals;
-- this feature does not store activity events, addresses, or login history.
-- Keep the privileged implementation outside the PostgREST-exposed schema.
CREATE SCHEMA IF NOT EXISTS toreca_admin_private;
REVOKE ALL ON SCHEMA toreca_admin_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA toreca_admin_private TO authenticated;

CREATE OR REPLACE FUNCTION toreca_admin_private.logged_in_users_v1()
RETURNS TABLE (display_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
  current_claims jsonb := (SELECT auth.jwt());
BEGIN
  -- The browser's developer-tab check is only UI. The database independently
  -- checks the developer UID, JWT role, live session and Discord role proof.
  IF current_user_id IS DISTINCT FROM '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid
     OR current_claims->>'role' IS DISTINCT FROM 'authenticated'
     OR NOT EXISTS (
       SELECT 1
       FROM auth.sessions AS session
       JOIN auth.users AS account ON account.id = session.user_id
       WHERE session.id::text = current_claims->>'session_id'
         AND session.user_id = current_user_id
         AND (session.not_after IS NULL OR session.not_after > pg_catalog.now())
         AND (account.banned_until IS NULL OR account.banned_until <= pg_catalog.now())
         AND (
           EXISTS (
             SELECT 1 FROM public.discord_remembered_sessions_v1 AS approved
             WHERE approved.session_id = session.id AND approved.user_id = session.user_id
               AND approved.authorized_until > pg_catalog.now()
           ) OR EXISTS (
             SELECT 1 FROM public.discord_role_access_v1 AS approved
             WHERE approved.user_id = session.user_id AND approved.valid_until > pg_catalog.now()
           )
         )
     )
  THEN
    RAISE EXCEPTION 'Developer access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (identity.user_id)
    pg_catalog.left(COALESCE(
      NULLIF(pg_catalog.btrim(identity.identity_data #>> '{custom_claims,global_name}'), ''),
      NULLIF(pg_catalog.btrim(identity.identity_data->>'global_name'), ''),
      NULLIF(pg_catalog.btrim(identity.identity_data->>'full_name'), ''),
      NULLIF(pg_catalog.btrim(identity.identity_data->>'name'), ''),
      'Discordユーザー'
    ), 80) AS display_name
  FROM auth.identities AS identity
  JOIN auth.users AS account ON account.id = identity.user_id
  WHERE identity.provider = 'discord'
    AND (account.banned_until IS NULL OR account.banned_until <= pg_catalog.now())
    AND EXISTS (
      SELECT 1
      FROM auth.sessions AS session
      JOIN public.discord_remembered_sessions_v1 AS approved
        ON approved.session_id = session.id AND approved.user_id = session.user_id
      WHERE session.user_id = identity.user_id
        AND (session.not_after IS NULL OR session.not_after > pg_catalog.now())
        AND approved.authorized_until > pg_catalog.now()
    )
  ORDER BY identity.user_id;
END;
$function$;

REVOKE ALL ON FUNCTION toreca_admin_private.logged_in_users_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION toreca_admin_private.logged_in_users_v1() TO authenticated;

-- The public entry point is an invoker; the privileged function above always
-- performs its own authorization and is not in an API-exposed schema.
CREATE OR REPLACE FUNCTION public.toreca_admin_logged_in_users_v1()
RETURNS TABLE (display_name text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT result.display_name FROM toreca_admin_private.logged_in_users_v1() AS result;
$function$;

REVOKE ALL ON FUNCTION public.toreca_admin_logged_in_users_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toreca_admin_logged_in_users_v1() TO authenticated;
