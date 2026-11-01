-- v21.166: Per-store locations for manual lottery registrations.
-- Legacy store_name/prefecture are retained for backwards compatibility.
-- Existing RLS, history and Discord notification behavior stay unchanged.
BEGIN;
ALTER TABLE public.lottery_app_events
  ADD COLUMN IF NOT EXISTS stores jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint WHERE conrelid='public.lottery_app_events'::regclass
      AND conname='lottery_app_stores_array_max_100'
  ) THEN
    ALTER TABLE public.lottery_app_events
      ADD CONSTRAINT lottery_app_stores_array_max_100
      CHECK (CASE WHEN pg_catalog.jsonb_typeof(stores)='array'
                  THEN pg_catalog.jsonb_array_length(stores)<=100 ELSE false END);
  END IF;
END $$;
DROP TRIGGER IF EXISTS lottery_store_sync_event_v1 ON public.lottery_app_events;
CREATE TRIGGER lottery_store_sync_event_v1
  AFTER INSERT OR UPDATE OF store_name,prefecture,stores
  ON public.lottery_app_events
  FOR EACH ROW EXECUTE FUNCTION private.lottery_store_event_sync_v1();
COMMIT;
