-- v21.80 - Multi-store lottery card editor schema synchronization
-- Production is already migrated. Keep this patch in source control for audit.
-- Card rows now store an ordered JSONB list (stores), while edited_fields
-- uses 'stores' to signify an intentional override. Without this updated
-- whitelist, saving a multi-store edit fails a CHECK constraint.
--
-- The existing 'stores' column and max-60 JSON-array constraint are
-- provisioned in production by the initial v21.80 change.
--
-- Intended usage: execute only in an environment where the v21.80 stores
-- column already exists. Existing rows and correction history are preserved.
begin;
alter table public.lottery_card_overrides
  drop constraint if exists lottery_card_edited_fields_valid;
alter table public.lottery_card_overrides
  add constraint lottery_card_edited_fields_valid
  check (
    edited_fields <@ array[
      'event_title','product_name','store_name','prefecture','stores',
      'application_start_at','application_end_at',
      'review_category','product_type'
    ]::text[]
  );
commit;
