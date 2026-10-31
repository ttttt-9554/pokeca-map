-- v21.151: Corroborated, explicitly UNCONFIRMED Pokemon Center sale signals.
-- Never infer stock status from community messages or bypass a waiting room.
-- Signals originate only from allowlisted official product URLs and
-- independent recent non-bot reports, and contain no message bodies or IDs.
CREATE TABLE IF NOT EXISTS private.guerrilla_sale_signal_evidence_v1 (
  message_hash text PRIMARY KEY CHECK (message_hash ~ '^[a-f0-9]{64}$'),
  author_hash text NOT NULL CHECK (author_hash ~ '^[a-f0-9]{64}$'),
  statement_hash text NOT NULL CHECK (statement_hash ~ '^[a-f0-9]{64}$'),
  channel_hash text NOT NULL CHECK (channel_hash ~ '^[a-f0-9]{64}$'),
  url text NOT NULL CHECK (url ~
    '^https://www[.]pokemoncenter-online[.]com/[0-9]{6,20}(-[A-Za-z0-9_-]+)?[.]html$'),
  report_kind text NOT NULL CHECK (report_kind IN ('pack','deck')),
  reported_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guerrilla_sale_signal_recent_v1
 ON private.guerrilla_sale_signal_evidence_v1 (url,reported_at DESC);
ALTER TABLE private.guerrilla_sale_signal_evidence_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.guerrilla_sale_signal_evidence_v1 FROM PUBLIC,anon,authenticated;

-- Existing confirmed sale events retain their established values.
ALTER TABLE public.guerrilla_sale_events
 DROP CONSTRAINT IF EXISTS guerrilla_sale_events_kind_check;
ALTER TABLE public.guerrilla_sale_events
 ADD CONSTRAINT guerrilla_sale_events_kind_check
 CHECK (kind IN ('restock','new_product','reported_unconfirmed'));

-- Rumors never enter the existing sale-confirmed Discord channel.
CREATE OR REPLACE FUNCTION private.guerrilla_sale_enqueue_discord()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
BEGIN
  IF NEW.kind='reported_unconfirmed' THEN RETURN NULL; END IF;
  INSERT INTO public.guerrilla_sale_discord_queue(event_id)
  VALUES(NEW.id) ON CONFLICT(event_id) DO NOTHING;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION private.guerrilla_sale_enqueue_discord()
 FROM PUBLIC,anon,authenticated;

-- Narrow server-only input: report text and author/channel IDs are never stored.
CREATE OR REPLACE FUNCTION public.guerrilla_sale_ingest_reports_v1(p_reports jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  r jsonb;
  c record;
  t timestamptz;
  n integer:=0;
  emitted integer:=0;
  added integer;
  product_id text;
  display_name text;
BEGIN
  IF (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role only' USING ERRCODE='42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_reports) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(p_reports)>100 THEN
    RAISE EXCEPTION 'Invalid signal batch' USING ERRCODE='22023';
  END IF;
  FOR r IN SELECT value FROM pg_catalog.jsonb_array_elements(p_reports) LOOP
    IF pg_catalog.jsonb_typeof(r) <> 'object'
      OR coalesce(r->>'message_hash','') !~ '^[a-f0-9]{64}$'
      OR coalesce(r->>'author_hash','') !~ '^[a-f0-9]{64}$'
      OR coalesce(r->>'statement_hash','') !~ '^[a-f0-9]{64}$'
      OR coalesce(r->>'channel_hash','') !~ '^[a-f0-9]{64}$'
      OR coalesce(r->>'url','') !~
         '^https://www[.]pokemoncenter-online[.]com/[0-9]{6,20}(-[A-Za-z0-9_-]+)?[.]html$'
      OR coalesce(r->>'report_kind','') NOT IN ('pack','deck')
      OR coalesce(r->>'posted_at','') !~
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' THEN
      CONTINUE;
    END IF;
    t:=(r->>'posted_at')::timestamptz;
    IF t < clock_timestamp()-interval '20 minutes'
      OR t > clock_timestamp()+interval '90 seconds' THEN CONTINUE; END IF;
    INSERT INTO private.guerrilla_sale_signal_evidence_v1
      (message_hash,author_hash,statement_hash,channel_hash,url,report_kind,reported_at)
    VALUES(r->>'message_hash',r->>'author_hash',r->>'statement_hash',
      r->>'channel_hash',r->>'url',r->>'report_kind',t)
    ON CONFLICT(message_hash) DO NOTHING;
    GET DIAGNOSTICS added=ROW_COUNT;
    n:=n+added;
  END LOOP;

  -- Keep only a short privacy-preserving rolling window; no message text.
  DELETE FROM private.guerrilla_sale_signal_evidence_v1
   WHERE reported_at < clock_timestamp()-interval '24 hours';

  -- Two independent authors with different messages, same verified URL,
  -- same sealed-product classification, all within fifteen minutes.
  FOR c IN
    SELECT e.url, min(e.report_kind) AS kind
    FROM private.guerrilla_sale_signal_evidence_v1 e
    WHERE e.reported_at >= clock_timestamp()-interval '15 minutes'
    GROUP BY e.url
    HAVING count(DISTINCT e.author_hash)>=2
       AND count(DISTINCT e.statement_hash)>=2
       AND count(DISTINCT e.report_kind)=1
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(c.url));
    IF EXISTS (
       SELECT 1 FROM public.guerrilla_sale_events x
       WHERE x.url=c.url AND x.site_key='pokemon'
         AND (
           (x.kind='reported_unconfirmed' AND
             x.detected_at >= clock_timestamp()-interval '2 hours')
           OR (x.kind IN ('new_product','restock') AND
             x.detected_at >= clock_timestamp()-interval '20 minutes')
         )
    ) THEN CONTINUE; END IF;
    IF EXISTS(
       SELECT 1 FROM public.guerrilla_sale_products x
       WHERE x.site_key='pokemon' AND x.url=c.url
         AND x.confirmed_status='available'
         AND x.checked_at >= clock_timestamp()-interval '20 minutes'
    ) THEN CONTINUE; END IF;

    product_id:=pg_catalog.encode(extensions.digest('pokemon|'||c.url,'sha256'),'hex');
    display_name:=CASE c.kind
       WHEN 'pack' THEN 'ポケモンカードゲーム パック／BOX（未確認報告）'
       ELSE 'ポケモンカードゲーム 構築デッキ（未確認報告）' END;
    INSERT INTO public.guerrilla_sale_products(id,site_key,url,product)
    VALUES (product_id,'pokemon',c.url,display_name)
    ON CONFLICT(id) DO NOTHING;
    -- Do not set confirmed_status, checked_at, or last_alert_at.
    -- These remain owned exclusively by official-store observations.
    INSERT INTO public.guerrilla_sale_events
      (product_id,site_key,url,product,scopes,kind,detected_at)
    VALUES(product_id,'pokemon',c.url,display_name,
      ARRAY['discord_corrob_unconfirmed']::text[],'reported_unconfirmed',
      clock_timestamp());
    emitted:=emitted+1;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('evidence_inserted',n,
    'unconfirmed_alerts_created',emitted);
END;
$function$;
REVOKE ALL ON FUNCTION public.guerrilla_sale_ingest_reports_v1(jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guerrilla_sale_ingest_reports_v1(jsonb)
 TO service_role;

-- Upgrade a previous UNCONFIRMED warning only after official confirmed stock.
-- The existing sale-observation function already sets last_alert_at when it
-- emits a confirmed event; this trigger only fills the initial-baseline gap.
CREATE OR REPLACE FUNCTION private.guerrilla_sale_upgrade_report_v1()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
BEGIN
  IF NEW.site_key <> 'pokemon'
     OR OLD.confirmed_status IS NOT DISTINCT FROM 'available'
     OR NEW.confirmed_status IS DISTINCT FROM 'available'
     OR NEW.last_alert_at IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.guerrilla_sale_events e
       WHERE e.product_id=NEW.id AND e.kind='reported_unconfirmed'
         AND e.detected_at >= clock_timestamp()-interval '30 minutes'
     )
  THEN RETURN NULL; END IF;
  UPDATE public.guerrilla_sale_products
    SET last_alert_at=clock_timestamp()
    WHERE id=NEW.id AND last_alert_at IS NULL;
  INSERT INTO public.guerrilla_sale_events
    (product_id,site_key,url,product,scopes,kind,detected_at)
  VALUES(NEW.id,'pokemon',NEW.url,NEW.product,
    ARRAY['official_after_unconfirmed']::text[],'new_product',clock_timestamp());
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION private.guerrilla_sale_upgrade_report_v1()
 FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS guerrilla_sale_upgrade_report_v1
 ON public.guerrilla_sale_products;
CREATE TRIGGER guerrilla_sale_upgrade_report_v1
 AFTER UPDATE OF confirmed_status ON public.guerrilla_sale_products
 FOR EACH ROW EXECUTE FUNCTION private.guerrilla_sale_upgrade_report_v1();
