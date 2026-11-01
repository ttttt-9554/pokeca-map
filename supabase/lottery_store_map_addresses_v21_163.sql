-- v21.163: Read-only, per-store Google Maps links in lottery cards.
-- The private store master remains RLS-protected. Only signed-in users may
-- read active store names, prefectures and addresses. No member data or IDs.
CREATE OR REPLACE FUNCTION public.lottery_store_map_addresses_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR
     (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Login required' USING ERRCODE='42501';
  END IF;

  -- Return only location fields of active store masters.
  -- No account records, user identifiers, merge candidates or edit permissions.
  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'name',x.store_name,
      'prefecture',x.prefecture,
      'address',x.address
    ) ORDER BY x.prefecture,x.store_name
  ),'[]'::jsonb)
  INTO result FROM (
    SELECT m.store_name,m.prefecture,m.address
    FROM private.lottery_store_master_v1 m
    WHERE m.merged_into IS NULL AND m.address IS NOT NULL
      AND pg_catalog.btrim(m.address)<>''
    ORDER BY m.prefecture,m.store_name
    LIMIT 5000
  ) AS x;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.lottery_store_map_addresses_v1()
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_store_map_addresses_v1()
 TO authenticated;
