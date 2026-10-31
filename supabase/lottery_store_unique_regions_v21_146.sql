-- v21.146: Read-only, service-role-only, unique-prefecture store lookup.
-- Used by GitHub's LivePocket collector as a fallback for missing store regions.
-- Private application data is never exposed.
CREATE OR REPLACE FUNCTION public.lottery_store_unique_regions_v1()
RETURNS TABLE(norm_name text, prefecture text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role only' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT m.norm_name, MIN(m.prefecture)::text AS prefecture
    FROM private.lottery_store_master_v1 AS m
    WHERE length(m.norm_name) >= 6
      AND m.prefecture ~ '(都|道|府|県)$'
    GROUP BY m.norm_name
    HAVING COUNT(DISTINCT m.prefecture) = 1
    ORDER BY m.norm_name;
END;
$function$;
REVOKE ALL ON FUNCTION public.lottery_store_unique_regions_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_store_unique_regions_v1()
  TO service_role;