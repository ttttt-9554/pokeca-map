-- Toreca Radar: optional per-store addresses for existing master entries.
-- Do not alter store names, prefectures, aliases, matching, or lottery records.
-- Historical Tochigi CSV matches below are provisional until reverified.
BEGIN;
ALTER TABLE private.lottery_store_master_v1
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS address_source text,
  ADD COLUMN IF NOT EXISTS address_updated_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='private.lottery_store_master_v1'::regclass
      AND conname='lottery_store_master_address_length_v1'
  ) THEN
    ALTER TABLE private.lottery_store_master_v1
      ADD CONSTRAINT lottery_store_master_address_length_v1
      CHECK(address IS NULL OR length(address) BETWEEN 1 AND 250);
  END IF;
END; $$;
CREATE OR REPLACE FUNCTION public.lottery_store_address_update_v1(p_store_id uuid, p_address text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  row_data record;
  clean_address text := pg_catalog.btrim(coalesce(p_address,''));
BEGIN
  IF (SELECT auth.uid()) IS DISTINCT FROM
     '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
  END IF;
  IF length(clean_address)>250 THEN
    RAISE EXCEPTION 'Invalid address' USING ERRCODE='22023';
  END IF;
  SELECT id,store_name,prefecture,merged_into INTO row_data
    FROM private.lottery_store_master_v1 WHERE id=p_store_id FOR UPDATE;
  IF NOT FOUND OR row_data.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'Active store not found' USING ERRCODE='22023';
  END IF;
  IF clean_address<>'' AND
     left(clean_address,length(row_data.prefecture))<>row_data.prefecture THEN
    RAISE EXCEPTION 'Address prefecture does not match store' USING ERRCODE='22023';
  END IF;
  UPDATE private.lottery_store_master_v1 SET
    address=nullif(clean_address,''),
    address_source=CASE WHEN clean_address='' THEN NULL ELSE 'developer_entry' END,
    address_updated_at=clock_timestamp(),
    updated_at=clock_timestamp()
  WHERE id=row_data.id;
  RETURN pg_catalog.jsonb_build_object('success',true,'id',row_data.id,'address',nullif(clean_address,''));
END;
$function$;

CREATE OR REPLACE FUNCTION public.lottery_store_admin_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;
BEGIN
 IF (SELECT auth.uid()) IS DISTINCT FROM
   '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid
 THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;

 SELECT pg_catalog.jsonb_build_object(
  'masters',coalesce((
   SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'id',m.id,'name',m.store_name,'prefecture',m.prefecture,
     'merged_into',m.merged_into,'created_at',m.created_at,'address',m.address,'address_source',m.address_source,'address_updated_at',m.address_updated_at)
     ORDER BY m.prefecture,m.store_name)
   FROM private.lottery_store_master_v1 m
  ),'[]'::jsonb),
  'candidates',coalesce((
   SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'left_id',p.left_id,'right_id',p.right_id,
    'left_name',p.left_name,'right_name',p.right_name,
    'prefecture',p.prefecture,'similarity',p.score)
    ORDER BY p.score DESC)
   FROM (
    SELECT a.id left_id,b.id right_id,a.store_name left_name,
      b.store_name right_name,a.prefecture,
      round(extensions.similarity(a.norm_name,b.norm_name)::numeric,2) score
    FROM private.lottery_store_master_v1 a
    JOIN private.lottery_store_master_v1 b ON
      a.id<b.id AND a.prefecture=b.prefecture
      AND a.merged_into IS NULL AND b.merged_into IS NULL
    LEFT JOIN private.lottery_store_pair_review_v1 rev
      ON rev.left_id=a.id AND rev.right_id=b.id
    WHERE rev.left_id IS NULL AND
      (extensions.similarity(a.norm_name,b.norm_name)>=0.53
       OR (length(a.norm_name)>=5 AND length(b.norm_name)>=5 AND
        (a.norm_name LIKE '%'||b.norm_name||'%'
         OR b.norm_name LIKE '%'||a.norm_name||'%')))
    ORDER BY score DESC,a.store_name,b.store_name LIMIT 120
   ) p
  ),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.lottery_store_address_update_v1(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_store_address_update_v1(uuid,text)
  TO authenticated;
-- Existing local CSV, exact normalized store name + matching prefecture only.
WITH seeds(store_name,prefecture,address) AS (
 VALUES
  ('TSUTAYA Trading Card 宇都宮インターパークビレッジ','栃木県','栃木県宇都宮市インターパーク4-1-3'),
  ('TSUTAYA400号西那須野店','栃木県','栃木県那須塩原市太夫塚6-232-8'),
  ('TSUTAYA佐野店','栃木県','栃木県佐野市田島町51'),
  ('TSUTAYA宇都宮南店','栃木県','栃木県宇都宮市針ヶ谷町472-7'),
  ('TSUTAYA宇都宮竹林店','栃木県','栃木県宇都宮市竹林町549-1'),
  ('ＴＳＵＴＡＹＡ真岡店','栃木県','栃木県真岡市亀山1-20-4'),
  ('TSUTAYA鹿沼店','栃木県','栃木県鹿沼市晃望台22-1'),
  ('イエローサブマリン宇都宮店','栃木県','栃木県宇都宮市曲師町2-8 フェスタ2F'),
  ('トレーディングカードピット小山駅前店','栃木県','栃木県小山市駅東通り2-3-15'),
  ('ビッグワンTSUTAYAさくら店','栃木県','栃木県さくら市櫻野505')
)
UPDATE private.lottery_store_master_v1 m SET
  address=seeds.address,
  address_source='legacy_csv_unverified',
  address_updated_at=clock_timestamp(),
  updated_at=clock_timestamp()
FROM seeds
WHERE m.store_name=seeds.store_name
  AND m.prefecture=seeds.prefecture
  AND m.merged_into IS NULL
  AND m.address IS NULL;
COMMIT;
