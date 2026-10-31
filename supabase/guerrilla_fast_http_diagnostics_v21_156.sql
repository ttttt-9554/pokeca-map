-- v21.156: Non-sensitive, bounded HTTP diagnostics for Pokemon Center waiting room.
-- Store no Set-Cookie values, session tokens, redirect paths/query strings, IPs,
-- user identifiers, response bodies, or raw challenge headers.
ALTER TABLE public.guerrilla_fast_state
 ADD COLUMN IF NOT EXISTS response_diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.guerrilla_fast_state
 DROP CONSTRAINT IF EXISTS guerrilla_fast_response_diagnostics_v1_check;
ALTER TABLE public.guerrilla_fast_state
 ADD CONSTRAINT guerrilla_fast_response_diagnostics_v1_check
 CHECK (pg_catalog.jsonb_typeof(response_diagnostics)='array'
        AND pg_catalog.jsonb_array_length(response_diagnostics)<=8);

-- Reuse existing developer-only, uid-checked RPC. RLS remains enabled and
-- public.guerrilla_fast_state continues to have no direct read policies.
CREATE OR REPLACE FUNCTION public.guerrilla_fast_admin_health_v1()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $function$
BEGIN
 IF (SELECT auth.uid()) IS DISTINCT FROM
   '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid THEN
   RAISE EXCEPTION 'Developer authorization required' USING ERRCODE='42501';
 END IF;
 RETURN COALESCE((
   SELECT pg_catalog.jsonb_agg(
     pg_catalog.jsonb_build_object(
       'site_key',f.site_key,
       'baseline_ready',f.baseline_ready,
       'last_status',f.last_status,
       'last_run_at',f.last_run_at,
       'last_success_at',f.last_success_at,
       'cooldown_until',f.cooldown_until,
       'last_product_count',f.last_product_count,
       'last_error',left(COALESCE(f.last_error,''),150),
       'response_diagnostics',f.response_diagnostics
     )
     ORDER BY f.site_key
   ) FROM public.guerrilla_fast_state f
   WHERE f.site_key IN ('amenity','pokemon')
 ),'[]'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.guerrilla_fast_admin_health_v1()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guerrilla_fast_admin_health_v1()
  TO authenticated;
