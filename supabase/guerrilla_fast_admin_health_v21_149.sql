-- v21.149: Developer-only real-time fast-monitor health (no token or private customer data).
-- The dashboard previously showed 'automatic monitoring' based solely on a saved enabled flag.
-- Avoid incorrectly reporting success while Pokemon Center is in its waiting room.
CREATE OR REPLACE FUNCTION public.guerrilla_fast_admin_health_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS DISTINCT FROM
       '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid THEN
    RAISE EXCEPTION 'Developer authorization required' USING ERRCODE='42501';
  END IF;
  RETURN COALESCE((
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'site_key', f.site_key,
        'baseline_ready', f.baseline_ready,
        'last_status', f.last_status,
        'last_run_at', f.last_run_at,
        'last_success_at', f.last_success_at,
        'cooldown_until', f.cooldown_until,
        'last_product_count', f.last_product_count,
        'last_error', left(COALESCE(f.last_error,''),150)
      )
      ORDER BY f.site_key
    )
    FROM public.guerrilla_fast_state AS f
    WHERE f.site_key IN ('amenity','pokemon')
  ), '[]'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.guerrilla_fast_admin_health_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guerrilla_fast_admin_health_v1()
  TO authenticated;
