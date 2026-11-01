-- v21.159: Signed-in users may read only reference-only sales-format fields
-- on lottery cards. The private editor and raw notes stay developer-only.
-- Never grant public SELECT on public.info_plaza_store_sales.

CREATE OR REPLACE FUNCTION public.lottery_store_sales_reference_v1()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $function$
DECLARE result jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL
     OR (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Login required' USING ERRCODE='42501';
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'store_name', s.store_name,
      'store_key', s.store_key,
      'prefecture', s.prefecture,
      'genre', s.genre,
      'shrink_state', s.shrink_state,
      'peri_state', s.peri_state,
      'tape_cut_state', s.tape_cut_state,
      'updated_at', s.updated_at
    ) ORDER BY s.store_key,s.prefecture,s.genre
  ),'[]'::jsonb) INTO result
  FROM (
    SELECT store_name,store_key,prefecture,genre,
      shrink_state,peri_state,tape_cut_state,updated_at
    FROM public.info_plaza_store_sales
    WHERE (genre='pokemon' AND (shrink_state<>'unknown' OR peri_state<>'unknown'))
       OR (genre='onepiece' AND tape_cut_state<>'unknown')
    ORDER BY store_key,prefecture,genre LIMIT 5000
  ) s;

  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.lottery_store_sales_reference_v1()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_store_sales_reference_v1()
  TO authenticated;
