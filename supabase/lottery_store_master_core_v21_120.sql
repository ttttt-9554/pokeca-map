-- Private store master for lottery accounts. No account/user records become public.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE OR REPLACE FUNCTION private.lottery_store_norm_v1(p_name text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE n text;
BEGIN
 n:=pg_catalog.lower(pg_catalog.btrim(coalesce(p_name,'')));
 n:=pg_catalog.regexp_replace(n,'[[:space:]　・･._－（）()【】「」-]+','','g');
 n:=pg_catalog.regexp_replace(n,'様$','','g');
 n:=pg_catalog.regexp_replace(n,'^イエサブ','イエローサブマリン');
 IF n LIKE 'イエローサブマリン%' AND n NOT LIKE '%店' THEN n:=n||'店'; END IF;
 RETURN n;
END; $$;

CREATE TABLE IF NOT EXISTS private.lottery_store_master_v1 (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_name text NOT NULL CHECK(length(store_name) BETWEEN 2 AND 200),
 prefecture text NOT NULL CHECK(length(prefecture) BETWEEN 2 AND 30),
 norm_name text NOT NULL CHECK(length(norm_name) BETWEEN 2 AND 200),
 merged_into uuid REFERENCES private.lottery_store_master_v1(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(prefecture,norm_name),
 CHECK(merged_into IS NULL OR merged_into<>id)
);
CREATE TABLE IF NOT EXISTS private.lottery_store_pair_review_v1 (
 left_id uuid NOT NULL REFERENCES private.lottery_store_master_v1(id) ON DELETE CASCADE,
 right_id uuid NOT NULL REFERENCES private.lottery_store_master_v1(id) ON DELETE CASCADE,
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(left_id,right_id), CHECK(left_id<right_id)
);
ALTER TABLE private.lottery_store_master_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.lottery_store_pair_review_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.lottery_store_master_v1,private.lottery_store_pair_review_v1
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.lottery_store_norm_v1(text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.lottery_store_add_v1(p_name text,p_pref text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n text; pref text; result_id uuid;
BEGIN
 pref:=pg_catalog.btrim(coalesce(p_pref,''));
 n:=private.lottery_store_norm_v1(p_name);
 IF length(pref) NOT BETWEEN 2 AND 30 OR pref !~ '[都道府県]$'
    OR length(n) NOT BETWEEN 3 AND 200
    OR n IN ('未確認','店舗未確認','不明','対象店舗','複数店舗','全店舗','全国','店舗情報なし','なし','不特定店舗')
    OR n LIKE '%店舗未確認%' OR n LIKE '%情報なし%'
 THEN RETURN NULL; END IF;
 INSERT INTO private.lottery_store_master_v1(store_name,prefecture,norm_name)
 VALUES(left(pg_catalog.btrim(p_name),200),pref,n)
 ON CONFLICT(prefecture,norm_name) DO NOTHING;
 SELECT id INTO result_id FROM private.lottery_store_master_v1
 WHERE prefecture=pref AND norm_name=n;
 RETURN result_id;
END; $$;
REVOKE ALL ON FUNCTION private.lottery_store_add_v1(text,text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.lottery_store_account_sync_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row_data jsonb;
BEGIN
 FOR row_data IN SELECT value FROM pg_catalog.jsonb_array_elements(
  CASE WHEN pg_catalog.jsonb_typeof(NEW.account_entries)='array'
   THEN NEW.account_entries ELSE '[]'::jsonb END
 ) LOOP
  IF row_data->>'application_count'='1' THEN
   PERFORM private.lottery_store_add_v1(
    row_data->>'store_name',row_data->>'store_prefecture');
  END IF;
 END LOOP;
 RETURN NULL;
END; $$;
DROP TRIGGER IF EXISTS lottery_store_sync_accounts_v1 ON public.lottery_user_entries;
CREATE TRIGGER lottery_store_sync_accounts_v1
 AFTER INSERT OR UPDATE OF account_entries ON public.lottery_user_entries
 FOR EACH ROW EXECUTE FUNCTION private.lottery_store_account_sync_v1();
DROP TRIGGER IF EXISTS lottery_store_sync_accounts_v1 ON public.lottery_external_user_entries;
CREATE TRIGGER lottery_store_sync_accounts_v1
 AFTER INSERT OR UPDATE OF account_entries ON public.lottery_external_user_entries
 FOR EACH ROW EXECUTE FUNCTION private.lottery_store_account_sync_v1();

CREATE OR REPLACE FUNCTION private.lottery_store_event_sync_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM private.lottery_store_add_v1(NEW.store_name,NEW.prefecture);
 RETURN NULL;
END; $$;
DROP TRIGGER IF EXISTS lottery_store_sync_event_v1 ON public.lottery_app_events;
CREATE TRIGGER lottery_store_sync_event_v1
 AFTER INSERT OR UPDATE OF store_name,prefecture ON public.lottery_app_events
 FOR EACH ROW EXECUTE FUNCTION private.lottery_store_event_sync_v1();
DROP TRIGGER IF EXISTS lottery_store_sync_event_v1 ON public.lottery_card_overrides;
CREATE TRIGGER lottery_store_sync_event_v1
 AFTER INSERT OR UPDATE OF store_name,prefecture ON public.lottery_card_overrides
 FOR EACH ROW EXECUTE FUNCTION private.lottery_store_event_sync_v1();

-- Import existing data without changing private ticket counts or outcomes.
SELECT private.lottery_store_add_v1(name,prefecture) FROM (
 SELECT DISTINCT a.value->>'store_name' name,
   a.value->>'store_prefecture' prefecture
 FROM (
  SELECT account_entries FROM public.lottery_user_entries
  UNION ALL SELECT account_entries FROM public.lottery_external_user_entries
 ) r
 CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
  CASE WHEN pg_catalog.jsonb_typeof(r.account_entries)='array'
   THEN r.account_entries ELSE '[]'::jsonb END) a
 WHERE a.value->>'application_count'='1'
 UNION SELECT store_name,prefecture FROM public.lottery_app_events
 UNION SELECT store_name,prefecture FROM public.lottery_card_overrides
) d;
