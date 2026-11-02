-- v21.167: Store-master merged-name resolution without rewriting source/audit records.
-- Read-only public alias/target business names and target address only; no
-- master IDs, unmerged store directory, user records or application history.
BEGIN;
CREATE OR REPLACE FUNCTION public.lottery_store_canonical_reference_v1()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $function$
DECLARE result jsonb;
DECLARE role_name text := (SELECT auth.jwt()->>'role');
BEGIN
  IF role_name NOT IN ('anon','authenticated') OR role_name IS NULL OR
     (role_name='authenticated' AND (SELECT auth.uid()) IS NULL) THEN
    RAISE EXCEPTION 'Public store reference only' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'source_name',s.store_name,'source_prefecture',s.prefecture,
    'name',m.store_name,'prefecture',m.prefecture,'address',m.address
  ) ORDER BY s.prefecture,s.store_name),'[]'::jsonb) INTO result
  FROM private.lottery_store_master_v1 s
  JOIN private.lottery_store_master_v1 m ON m.id=s.merged_into
  WHERE s.merged_into IS NOT NULL AND m.merged_into IS NULL
    AND s.prefecture=m.prefecture
    AND s.store_name IS NOT NULL AND m.store_name IS NOT NULL;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.lottery_store_canonical_reference_v1()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_store_canonical_reference_v1()
  TO anon,authenticated;
COMMIT;
