-- Automatic address enrichment. Backend only; no user accounts are returned.
-- Keep manual addresses and merged sources intact. No fuzzy matching in SQL.
CREATE OR REPLACE FUNCTION public.lottery_store_address_pending_v1()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
  IF coalesce((SELECT auth.jwt()->>'role'),'') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role only' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('name',m.store_name,'prefecture',m.prefecture)
    ORDER BY m.created_at DESC,m.store_name),'[]'::jsonb) INTO result
  FROM (SELECT store_name,prefecture,created_at FROM private.lottery_store_master_v1
    WHERE merged_into IS NULL AND nullif(btrim(address),'') IS NULL
    ORDER BY created_at DESC,store_name LIMIT 1200) m;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.lottery_store_address_fill_v1(p_stores jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE updated_count integer;
BEGIN
  IF coalesce((SELECT auth.jwt()->>'role'),'') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role only' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_stores) IS DISTINCT FROM 'array' OR jsonb_array_length(p_stores)>1200 THEN
    RAISE EXCEPTION 'Expected an address array (max 1200)' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stores) s WHERE
    jsonb_typeof(s) IS DISTINCT FROM 'object' OR
    jsonb_typeof(s->'name') IS DISTINCT FROM 'string' OR
    length(btrim(s->>'name')) NOT BETWEEN 2 AND 200 OR
    jsonb_typeof(s->'prefecture') IS DISTINCT FROM 'string' OR
    coalesce(s->>'prefecture','') !~ '^(北海道|東京都|京都府|大阪府|.{2,3}県)$' OR
    jsonb_typeof(s->'address') IS DISTINCT FROM 'string' OR
    length(btrim(s->>'address')) NOT BETWEEN 6 AND 250 OR
    left(btrim(s->>'address'),length(s->>'prefecture')) IS DISTINCT FROM s->>'prefecture' OR
    s->>'address' ~ E'[<>\r\n]' OR s->>'address' !~ '[0-9０-９]' OR
    jsonb_typeof(s->'source_url') IS DISTINCT FROM 'string' OR
    length(s->>'source_url')>500 OR
    coalesce(s->>'source_url','') !~ '^https://(www[.]wonder[.]co[.]jp|shinseido[.]co[.]jp|www[.]furu1[.]net|www[.]kidsrepublic[.]jp|map[.]pokemon-card[.]com|store-tsutaya[.]tsite[.]jp)/'
  ) THEN
    RAISE EXCEPTION 'Invalid official store address' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stores) s
    GROUP BY btrim(s->>'name'),s->>'prefecture' HAVING count(DISTINCT btrim(s->>'address'))>1) THEN
    RAISE EXCEPTION 'Conflicting store addresses' USING ERRCODE='22023';
  END IF;
  WITH rows AS (
    SELECT DISTINCT ON (btrim(s->>'name'),s->>'prefecture')
      btrim(s->>'name') AS name,s->>'prefecture' AS prefecture,
      btrim(s->>'address') AS address,s->>'source_url' AS source_url
    FROM jsonb_array_elements(p_stores) s
    ORDER BY btrim(s->>'name'),s->>'prefecture',s->>'source_url'
  )
  UPDATE private.lottery_store_master_v1 m SET
    address=rows.address,address_source=rows.source_url,
    address_updated_at=clock_timestamp(),updated_at=clock_timestamp()
  FROM rows WHERE m.store_name=rows.name AND m.prefecture=rows.prefecture
    AND m.merged_into IS NULL AND nullif(btrim(m.address),'') IS NULL;
  GET DIAGNOSTICS updated_count=ROW_COUNT;
  RETURN jsonb_build_object('updated',updated_count);
END;
$$;
REVOKE ALL ON FUNCTION public.lottery_store_address_pending_v1() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.lottery_store_address_fill_v1(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_store_address_pending_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.lottery_store_address_fill_v1(jsonb) TO service_role;
