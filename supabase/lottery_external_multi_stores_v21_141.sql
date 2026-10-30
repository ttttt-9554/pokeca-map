-- v21.141: External lottery overrides can now describe up to 100 stores.
-- Existing store_name / prefecture fields remain for old cards, alerts,
-- integrations, and already-saved one-store corrections.
ALTER TABLE public.lottery_external_event_overrides
  ADD COLUMN IF NOT EXISTS stores jsonb;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.lottery_external_event_overrides'::regclass
      AND conname='lottery_ext_stores_array_max_100'
  ) THEN
    ALTER TABLE public.lottery_external_event_overrides
      ADD CONSTRAINT lottery_ext_stores_array_max_100
      CHECK (stores IS NULL OR (
        CASE WHEN jsonb_typeof(stores)='array'
          THEN jsonb_array_length(stores)<=100
          ELSE false END
      ));
  END IF;
END
$migration$;

-- The old verified-edit Discord trigger compared only the first store.
-- Include the full set so a change to store #2+ is also a meaningful edit.
CREATE OR REPLACE FUNCTION private.lottery_discord_enqueue_external_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  changed text[] := ARRAY[]::text[];
BEGIN
  IF NEW.state <> 'active' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state <> 'active' THEN
      RETURN NULL;
    END IF;
    IF ROW(NEW.event_title,NEW.store_name,NEW.prefecture,NEW.stores,
      NEW.review_category,NEW.product_type,
      NEW.application_start_at,NEW.application_end_at)
      IS NOT DISTINCT FROM
      ROW(OLD.event_title,OLD.store_name,OLD.prefecture,OLD.stores,
      OLD.review_category,OLD.product_type,
      OLD.application_start_at,OLD.application_end_at)
    THEN
      RETURN NULL;
    END IF;
    IF NEW.event_title IS DISTINCT FROM OLD.event_title
      THEN changed:=array_append(changed,'イベント名・商品名'); END IF;
    IF NEW.store_name IS DISTINCT FROM OLD.store_name OR
       NEW.stores IS DISTINCT FROM OLD.stores
      THEN changed:=array_append(changed,'対象店舗'); END IF;
    IF NEW.prefecture IS DISTINCT FROM OLD.prefecture
      THEN changed:=array_append(changed,'都道府県'); END IF;
    IF NEW.review_category IS DISTINCT FROM OLD.review_category
      THEN changed:=array_append(changed,'ジャンル'); END IF;
    IF NEW.product_type IS DISTINCT FROM OLD.product_type
      THEN changed:=array_append(changed,'商品区分'); END IF;
    IF NEW.application_start_at IS DISTINCT FROM OLD.application_start_at
      THEN changed:=array_append(changed,'応募開始'); END IF;
    IF NEW.application_end_at IS DISTINCT FROM OLD.application_end_at
      THEN changed:=array_append(changed,'応募締切'); END IF;
  ELSE
    changed:=ARRAY['初回の手動確認'];
  END IF;

  INSERT INTO public.lottery_discord_queue(source,event_key,payload)
  VALUES(
    'external_edit',pg_catalog.gen_random_uuid()::text,
    pg_catalog.jsonb_build_object(
      'event_url',NEW.event_url,
      'event_title',left(coalesce(NEW.event_title,''),200),
      'store_name',left(coalesce(NEW.store_name,''),200),
      'prefecture',left(coalesce(NEW.prefecture,''),40),
      'stores',coalesce(NEW.stores,'[]'::jsonb),
      'review_category',NEW.review_category,
      'product_type',NEW.product_type,
      'application_start_at',NEW.application_start_at,
      'application_end_at',NEW.application_end_at,
      'changed_fields',pg_catalog.to_jsonb(changed),
      'edited_at',NEW.updated_at
    )
  );
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION private.lottery_discord_enqueue_external_edit()
  FROM PUBLIC,anon,authenticated;
