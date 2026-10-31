-- v21.145: Retain every validated store ever included in a lottery card.
-- Preserve the existing private master, aliases, user records and win/loss stats.
-- Changes are additive and idempotent.

-- All event sources: single-store and stores[] entries.
CREATE OR REPLACE FUNCTION private.lottery_store_event_sync_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  event jsonb := pg_catalog.to_jsonb(NEW);
  shop jsonb;
BEGIN
  PERFORM private.lottery_store_add_v1(event->>'store_name',event->>'prefecture');
  IF pg_catalog.jsonb_typeof(event->'stores')='array' THEN
    FOR shop IN SELECT value FROM pg_catalog.jsonb_array_elements(event->'stores') LOOP
      IF pg_catalog.jsonb_typeof(shop)='object' THEN
        PERFORM private.lottery_store_add_v1(shop->>'name',shop->>'prefecture');
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.lottery_store_event_sync_v1()
  FROM PUBLIC,anon,authenticated;

-- The full stores[] list is checked on INSERT as well as every edit.
DROP TRIGGER IF EXISTS lottery_store_sync_event_v1 ON public.lottery_card_overrides;
CREATE TRIGGER lottery_store_sync_event_v1
 AFTER INSERT OR UPDATE OF store_name,prefecture,stores
 ON public.lottery_card_overrides FOR EACH ROW
 EXECUTE FUNCTION private.lottery_store_event_sync_v1();

DROP TRIGGER IF EXISTS lottery_store_sync_external_event_v1
 ON public.lottery_external_event_overrides;
CREATE TRIGGER lottery_store_sync_external_event_v1
 AFTER INSERT OR UPDATE OF store_name,prefecture,stores
 ON public.lottery_external_event_overrides FOR EACH ROW
 EXECUTE FUNCTION private.lottery_store_event_sync_v1();

-- App/manual lottery registration already has the same shared trigger function.
-- Add LivePocket location corrections, which were previously omitted.
DROP TRIGGER IF EXISTS lottery_store_sync_location_v21_145
 ON public.livepocket_location_overrides;
CREATE TRIGGER lottery_store_sync_location_v21_145
 AFTER INSERT OR UPDATE OF store_name,prefecture
 ON public.livepocket_location_overrides FOR EACH ROW
 EXECUTE FUNCTION private.lottery_store_event_sync_v1();

-- Restricted backend-only importer for GitHub-published lottery catalog.
-- Public clients cannot invoke it or see the underlying private table.
CREATE OR REPLACE FUNCTION public.lottery_store_ingest_public_v1(p_stores jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  shop jsonb;
  accepted uuid;
  processed integer := 0;
BEGIN
  IF coalesce(auth.jwt()->>'role','') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role only' USING ERRCODE='42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_stores) IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(p_stores)>1200 THEN
    RAISE EXCEPTION 'Expected a store array (max 1200)'
      USING ERRCODE='22023';
  END IF;
  FOR shop IN SELECT value FROM pg_catalog.jsonb_array_elements(p_stores) LOOP
    IF pg_catalog.jsonb_typeof(shop)='object' THEN
      accepted := private.lottery_store_add_v1(
        shop->>'name', shop->>'prefecture');
      IF accepted IS NOT NULL THEN processed:=processed+1; END IF;
    END IF;
  END LOOP;
  RETURN processed;
END;
$$;
REVOKE ALL ON FUNCTION public.lottery_store_ingest_public_v1(jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_store_ingest_public_v1(jsonb)
  TO service_role;

-- Backfill all rows still stored in the app DB, including hidden/expired cards.
-- No deletion, correction, or publication of private user information.
SELECT private.lottery_store_add_v1(name,prefecture)
FROM (
  SELECT store_name AS name,prefecture FROM public.lottery_app_events
  UNION ALL SELECT store_name,prefecture FROM public.lottery_card_overrides
  UNION ALL SELECT store_name,prefecture FROM public.lottery_external_event_overrides
  UNION ALL SELECT store_name,prefecture FROM public.livepocket_location_overrides
) AS existing;

SELECT private.lottery_store_add_v1(shop->>'name',shop->>'prefecture')
FROM (
  SELECT stores FROM public.lottery_card_overrides
  UNION ALL SELECT stores FROM public.lottery_external_event_overrides
) AS events
CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
  CASE WHEN pg_catalog.jsonb_typeof(events.stores)='array'
    THEN events.stores ELSE '[]'::jsonb END
) AS shop
WHERE pg_catalog.jsonb_typeof(shop)='object';
