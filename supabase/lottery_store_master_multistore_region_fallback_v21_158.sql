-- v21.158: Complete missing regions in admin-corrected multi-store lotteries.
-- Safe exact-name match against the private store master, only when its
-- prefecture is unique. Never alter a previously entered region.
-- The normal public LivePocket collector keeps its separate read-only fallback.

CREATE OR REPLACE FUNCTION private.lottery_store_fill_missing_regions_v1(
  p_stores jsonb
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  shop jsonb;
  out_stores jsonb := '[]'::jsonb;
  normalized_name text;
  match_pref text;
BEGIN
  IF pg_catalog.jsonb_typeof(p_stores) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_stores) > 100
  THEN
    RETURN p_stores;
  END IF;

  FOR shop IN SELECT value FROM pg_catalog.jsonb_array_elements(p_stores)
  LOOP
    IF pg_catalog.jsonb_typeof(shop) = 'object'
       AND pg_catalog.btrim(coalesce(shop->>'prefecture','')) = ''
    THEN
      normalized_name := private.lottery_store_norm_v1(shop->>'name');
      IF pg_catalog.length(normalized_name) >= 6
         AND normalized_name NOT IN (
           'tsutaya','ゲオ','イオン','イトーヨーカドー',
           'ワンダーグー','wondergoo','古本市場','ブックオフ',
           'ヨドバシカメラ','ビックカメラ','ポケモンセンター',
           'ポケモンセンターオンライン','イエローサブマリン店'
         )
      THEN
        match_pref := NULL;
        SELECT pg_catalog.min(m.prefecture)
          INTO match_pref
        FROM private.lottery_store_master_v1 AS m
        WHERE m.norm_name = normalized_name
          AND m.prefecture ~ '(都|道|府|県)$'
        HAVING pg_catalog.count(DISTINCT m.prefecture) = 1;

        IF match_pref IS NOT NULL THEN
          shop := pg_catalog.jsonb_set(
            shop,'{prefecture}',pg_catalog.to_jsonb(match_pref),true
          );
        END IF;
      END IF;
    END IF;
    out_stores := out_stores || pg_catalog.jsonb_build_array(shop);
  END LOOP;
  RETURN out_stores;
END;
$function$;

REVOKE ALL ON FUNCTION private.lottery_store_fill_missing_regions_v1(jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.lottery_card_fill_store_regions_trigger_v1()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.stores_override) = 'array' THEN
    NEW.stores_override := private.lottery_store_fill_missing_regions_v1(
      NEW.stores_override
    );
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.lottery_card_fill_store_regions_trigger_v1()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS lottery_card_fill_store_regions_v21_158
  ON public.lottery_card_overrides;
CREATE TRIGGER lottery_card_fill_store_regions_v21_158
BEFORE INSERT OR UPDATE OF stores_override
ON public.lottery_card_overrides
FOR EACH ROW
EXECUTE FUNCTION private.lottery_card_fill_store_regions_trigger_v1();
