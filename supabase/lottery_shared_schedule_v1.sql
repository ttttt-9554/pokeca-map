-- Optional shared dates and Japan-local times. Existing rows inherit NULLs.
ALTER TABLE public.lottery_app_events
  ADD COLUMN IF NOT EXISTS result_announcement_date date,
  ADD COLUMN IF NOT EXISTS result_announcement_time time without time zone,
  ADD COLUMN IF NOT EXISTS purchase_start_date date,
  ADD COLUMN IF NOT EXISTS purchase_start_time time without time zone,
  ADD COLUMN IF NOT EXISTS purchase_end_date date,
  ADD COLUMN IF NOT EXISTS purchase_end_time time without time zone,
  DROP CONSTRAINT IF EXISTS lottery_app_events_shared_schedule_check,
  ADD CONSTRAINT lottery_app_events_shared_schedule_check CHECK (
    (result_announcement_time IS NULL OR result_announcement_date IS NOT NULL) AND
    (purchase_start_time IS NULL OR purchase_start_date IS NOT NULL) AND
    (purchase_end_time IS NULL OR purchase_end_date IS NOT NULL) AND
    purchase_start_date <= purchase_end_date AND
    (purchase_start_date <> purchase_end_date OR purchase_start_time <= purchase_end_time)
  );

-- The existing overlay can override one field at a time, including clearing it.
-- A NULL date may inherit the collector's value when the field is not edited.
ALTER TABLE public.lottery_card_overrides
  ADD COLUMN IF NOT EXISTS result_announcement_date date,
  ADD COLUMN IF NOT EXISTS result_announcement_time time without time zone,
  ADD COLUMN IF NOT EXISTS purchase_start_date date,
  ADD COLUMN IF NOT EXISTS purchase_start_time time without time zone,
  ADD COLUMN IF NOT EXISTS purchase_end_date date,
  ADD COLUMN IF NOT EXISTS purchase_end_time time without time zone,
  DROP CONSTRAINT IF EXISTS lottery_card_edited_fields_valid,
  ADD CONSTRAINT lottery_card_edited_fields_valid CHECK (edited_fields <@ ARRAY[
    'event_title','product_name','store_name','prefecture','stores',
    'application_start_at','application_end_at','review_category','product_type',
    'result_announcement_date','result_announcement_time','purchase_start_date','purchase_start_time',
    'purchase_end_date','purchase_end_time'
  ]::text[]);

NOTIFY pgrst, 'reload schema';
