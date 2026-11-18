-- Store selection belongs to the private tracking row, independently of accounts.
-- Additive rollout: old clients omit these fields and keep working. Existing
-- owner-only RLS policies, grants, account validation and shared RPCs stay intact.
alter table public.lottery_user_entries
  add column if not exists store_name text not null default ''
    check (char_length(store_name)<=200 and store_name=btrim(store_name)
      and store_name !~ '[[:cntrl:]]'),
  add column if not exists store_prefecture text not null default ''
    check (char_length(store_prefecture)<=80 and store_prefecture=btrim(store_prefecture)
      and store_prefecture !~ '[[:cntrl:]]' and (store_name<>'' or store_prefecture=''));

alter table public.lottery_external_user_entries
  add column if not exists store_name text not null default ''
    check (char_length(store_name)<=200 and store_name=btrim(store_name)
      and store_name !~ '[[:cntrl:]]'),
  add column if not exists store_prefecture text not null default ''
    check (char_length(store_prefecture)<=80 and store_prefecture=btrim(store_prefecture)
      and store_prefecture !~ '[[:cntrl:]]' and (store_name<>'' or store_prefecture=''));

notify pgrst, 'reload schema';
