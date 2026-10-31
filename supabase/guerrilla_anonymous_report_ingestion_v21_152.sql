-- v21.152: Accept ONLY anonymized aggregate corroboration from the
-- existing, owner-controlled GitHub Discord collector via server-side poll.
-- No user identities, message text or hashes enter this API.
-- Service-role-only; unavailable to browser clients or anonymous callers.
CREATE OR REPLACE FUNCTION public.guerrilla_sale_ingest_aggregates_v1(p_signals jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  r jsonb;
  link text;
  kind text;
  sent_at timestamptz;
  pid text;
  title text;
  added integer := 0;
  valid integer := 0;
BEGIN
  IF (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role only' USING ERRCODE='42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_signals) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(p_signals)>30 THEN
    RAISE EXCEPTION 'Unexpected signal batch' USING ERRCODE='22023';
  END IF;
  FOR r IN SELECT value FROM pg_catalog.jsonb_array_elements(p_signals) LOOP
    IF pg_catalog.jsonb_typeof(r)<>'object'
      OR coalesce(r->>'url','') !~
          '^https://www[.]pokemoncenter-online[.]com/[0-9]{6,20}(-[A-Za-z0-9_-]+)?[.]html$'
      OR coalesce(r->>'report_kind','') NOT IN ('pack','deck')
      OR coalesce(r->>'independent_reporters','') !~ '^[0-9]{1,2}$'
      OR coalesce(r->>'independent_statements','') !~ '^[0-9]{1,2}$'
      OR coalesce(r->>'independent_channels','') !~ '^[0-9]{1,2}$'
      OR coalesce(r->>'latest_at','') !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
    THEN CONTINUE; END IF;
    IF (r->>'independent_reporters')::integer<2
      OR (r->>'independent_statements')::integer<2
      OR (r->>'independent_channels')::integer<1
    THEN CONTINUE; END IF;
    sent_at:=(r->>'latest_at')::timestamptz;
    IF sent_at < clock_timestamp()-interval '15 minutes'
      OR sent_at > clock_timestamp()+interval '90 seconds'
    THEN CONTINUE; END IF;
    valid:=valid+1;
    link:=r->>'url';
    kind:=r->>'report_kind';
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(link));
    IF EXISTS (
      SELECT 1 FROM public.guerrilla_sale_events x
      WHERE x.site_key='pokemon' AND x.url=link
      AND ((x.kind='reported_unconfirmed'
           AND x.detected_at>=clock_timestamp()-interval '2 hours')
        OR (x.kind IN ('new_product','restock')
           AND x.detected_at>=clock_timestamp()-interval '20 minutes'))
    ) THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM public.guerrilla_sale_products x
      WHERE x.site_key='pokemon' AND x.url=link
        AND x.confirmed_status='available'
        AND x.checked_at>=clock_timestamp()-interval '20 minutes'
    ) THEN CONTINUE; END IF;

    pid:=pg_catalog.encode(extensions.digest('pokemon|'||link,'sha256'),'hex');
    title:=CASE kind WHEN 'pack' THEN
      'ポケモンカードゲーム パック／BOX（販売報告・未確認）'
      ELSE 'ポケモンカードゲーム 構築デッキ（販売報告・未確認）' END;
    INSERT INTO public.guerrilla_sale_products(id,site_key,url,product)
      VALUES(pid,'pokemon',link,title)
      ON CONFLICT(id) DO NOTHING;
    -- Preserve all first-party stock fields as unobserved; no false baseline.
    INSERT INTO public.guerrilla_sale_events
      (product_id,site_key,url,product,scopes,kind,detected_at)
    VALUES(pid,'pokemon',link,title,
      ARRAY['discord_anonymous_aggregate']::text[],
      'reported_unconfirmed',clock_timestamp());
    added:=added+1;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object(
    'eligible_signals',valid,'unconfirmed_alerts_created',added);
END;
$function$;
REVOKE ALL ON FUNCTION public.guerrilla_sale_ingest_aggregates_v1(jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guerrilla_sale_ingest_aggregates_v1(jsonb)
  TO service_role;
