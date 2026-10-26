-- v21.113: app registrations and in-store registrations share the existing
-- public lottery catalog, while private results remain in existing RLS tables.
-- Earlier rows use the default 'app'; their IDs, dates and ownership are unchanged.
alter table public.lottery_app_events
  add column if not exists registration_method text not null default 'app';
-- Applied to the live Supabase project as add_instore_method_to_manual_lottery_events.
alter table public.lottery_app_events
  add constraint lottery_app_events_registration_method_check
  check (registration_method in ('app','in_store'));
comment on column public.lottery_app_events.registration_method is
  'app: official app entry; in_store: face-to-face entry at a physical store';
