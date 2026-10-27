-- v21.115 — Discord notification for administrator-saved external lottery edits.
-- Reuse LOTTERY_DISCORD_WEBHOOK_URL (#新規抽選アラート) and the existing
-- retrying, rate-limited lottery queue; do not expose the webhook to clients.
-- No historical overrides are enqueued by this migration.
ALTER TABLE public.lottery_discord_queue
  DROP CONSTRAINT IF EXISTS lottery_discord_queue_source_check;
ALTER TABLE public.lottery_discord_queue
  ADD CONSTRAINT lottery_discord_queue_source_check
  CHECK (source IN ('app','livepocket','external_edit'));

CREATE OR REPLACE FUNCTION private.lottery_discord_enqueue_external_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  changed text[] := ARRAY[]::text[];
BEGIN
  -- A hidden/excluded URL must never produce a public Discord alert.
  IF NEW.state <> 'active' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- A restore is a separate action, not an "編集内容を保存" notification.
    IF OLD.state <> 'active' THEN
      RETURN NULL;
    END IF;
    -- updated_at touch alone is not a meaningful edit.
    IF ROW(NEW.event_title, NEW.store_name, NEW.prefecture, NEW.review_category,
      NEW.product_type, NEW.application_start_at, NEW.application_end_at)
      IS NOT DISTINCT FROM
      ROW(OLD.event_title, OLD.store_name, OLD.prefecture, OLD.review_category,
      OLD.product_type, OLD.application_start_at, OLD.application_end_at)
    THEN
      RETURN NULL;
    END IF;
    IF NEW.event_title IS DISTINCT FROM OLD.event_title
      THEN changed := array_append(changed,'イベント名・商品名'); END IF;
    IF NEW.store_name IS DISTINCT FROM OLD.store_name
      THEN changed := array_append(changed,'対象店舗'); END IF;
    IF NEW.prefecture IS DISTINCT FROM OLD.prefecture
      THEN changed := array_append(changed,'都道府県'); END IF;
    IF NEW.review_category IS DISTINCT FROM OLD.review_category
      THEN changed := array_append(changed,'ジャンル'); END IF;
    IF NEW.product_type IS DISTINCT FROM OLD.product_type
      THEN changed := array_append(changed,'商品区分'); END IF;
    IF NEW.application_start_at IS DISTINCT FROM OLD.application_start_at
      THEN changed := array_append(changed,'応募開始'); END IF;
    IF NEW.application_end_at IS DISTINCT FROM OLD.application_end_at
      THEN changed := array_append(changed,'応募締切'); END IF;
  ELSE
    changed := ARRAY['初回の手動確認'];
  END IF;

  -- A fresh UUID supports multiple edits of one URL; external URLs can be
  -- longer than the queue's 220-character event_key constraint.
  INSERT INTO public.lottery_discord_queue(source,event_key,payload)
  VALUES (
    'external_edit',
    pg_catalog.gen_random_uuid()::text,
    pg_catalog.jsonb_build_object(
      'event_url', NEW.event_url,
      'event_title', left(coalesce(NEW.event_title,''),200),
      'store_name', left(coalesce(NEW.store_name,''),200),
      'prefecture', left(coalesce(NEW.prefecture,''),40),
      'review_category', NEW.review_category,
      'product_type', NEW.product_type,
      'application_start_at', NEW.application_start_at,
      'application_end_at', NEW.application_end_at,
      'changed_fields', pg_catalog.to_jsonb(changed),
      'edited_at', NEW.updated_at
    )
  );
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION private.lottery_discord_enqueue_external_edit()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS lottery_discord_enqueue_external_edit
  ON public.lottery_external_event_overrides;
CREATE TRIGGER lottery_discord_enqueue_external_edit
AFTER INSERT OR UPDATE ON public.lottery_external_event_overrides
FOR EACH ROW EXECUTE FUNCTION private.lottery_discord_enqueue_external_edit();
