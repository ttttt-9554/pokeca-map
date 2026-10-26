-- Toreca Radar: private application account profiles and per-lottery allocations.
-- Personal labels, never passwords. Existing lottery rows remain unchanged.
create table if not exists public.lottery_private_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  is_default boolean not null default false,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lottery_private_accounts_owner_id_unique unique (user_id,id),
  constraint lottery_private_accounts_label_valid check (
    char_length(label) between 1 and 80
    and label = btrim(label) and label !~ '[[:cntrl:]]'
  ),
  constraint lottery_private_accounts_active_default check (
    not (is_default and is_archived)
  )
);
create unique index if not exists lottery_private_accounts_user_label_idx
  on public.lottery_private_accounts(user_id, lower(label));
create unique index if not exists lottery_private_accounts_default_idx
  on public.lottery_private_accounts(user_id) where is_default;

alter table public.lottery_private_accounts enable row level security;
revoke all on public.lottery_private_accounts from anon;
grant select, insert, update, delete on public.lottery_private_accounts to authenticated;

create policy lottery_private_accounts_select_own
  on public.lottery_private_accounts for select to authenticated
  using ((select auth.uid()) = user_id);
create policy lottery_private_accounts_insert_own
  on public.lottery_private_accounts for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy lottery_private_accounts_update_own
  on public.lottery_private_accounts for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy lottery_private_accounts_delete_own
  on public.lottery_private_accounts for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Atomic default selection, with invoker rights and owner-scoped RLS.
create or replace function public.lottery_set_default_private_account(p_account_id uuid)
returns void
language plpgsql security invoker set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Login required';
  end if;
  if not exists (
    select 1 from public.lottery_private_accounts a
    where a.user_id=v_uid and a.id=p_account_id and not a.is_archived
  ) then
    raise exception 'Account not found or archived';
  end if;
  update public.lottery_private_accounts
  set is_default=false, updated_at=now()
  where user_id=v_uid and is_default;
  update public.lottery_private_accounts
  set is_default=true, updated_at=now()
  where user_id=v_uid and id=p_account_id and not is_archived;
end
$function$;
revoke all on function public.lottery_set_default_private_account(uuid) from public, anon;
grant execute on function public.lottery_set_default_private_account(uuid) to authenticated;

-- Empty arrays for historic entries: old accounts are never guessed.
alter table public.lottery_user_entries
  add column if not exists account_entries jsonb not null default '[]'::jsonb;
alter table public.lottery_external_user_entries
  add column if not exists account_entries jsonb not null default '[]'::jsonb;

-- Invoker check keeps every allocation within the authenticated user's
-- private account list and within the existing public numeric aggregates.
create or replace function public.lottery_validate_private_account_entries()
returns trigger
language plpgsql security invoker set search_path = ''
as $function$
declare
  entry jsonb;
  v_account uuid;
  v_seen uuid[] := array[]::uuid[];
  v_app integer;
  v_won integer;
  v_lost integer;
  total_app bigint := 0;
  total_won bigint := 0;
  total_lost bigint := 0;
begin
  if new.account_entries is null or jsonb_typeof(new.account_entries) <> 'array'
     or jsonb_array_length(new.account_entries) > 40 then
    raise exception 'Invalid private account allocation list';
  end if;
  if new.application_count < 0 or new.won_count < 0 or new.lost_count < 0
     or new.application_count > 9999
     or new.won_count + new.lost_count > new.application_count then
    raise exception 'Invalid application totals';
  end if;
  for entry in select value from jsonb_array_elements(new.account_entries) loop
    if jsonb_typeof(entry) <> 'object'
       or jsonb_typeof(entry->'account_id') <> 'string' then
      raise exception 'Invalid account allocation';
    end if;
    begin
      v_account := (entry->>'account_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Invalid account identifier';
    end;
    if v_account is null or v_account = any(v_seen) then
      raise exception 'Missing or duplicated account';
    end if;
    v_seen := array_append(v_seen, v_account);
    if not exists (
      select 1 from public.lottery_private_accounts a
      where a.user_id=new.user_id and a.id=v_account
    ) then
      raise exception 'Private account does not belong to this user';
    end if;
    if coalesce(entry->>'application_count','') !~ '^[0-9]{1,4}$'
       or coalesce(entry->>'won_count','') !~ '^[0-9]{1,4}$'
       or coalesce(entry->>'lost_count','') !~ '^[0-9]{1,4}$' then
      raise exception 'Invalid account ticket numbers';
    end if;
    v_app := (entry->>'application_count')::integer;
    v_won := (entry->>'won_count')::integer;
    v_lost := (entry->>'lost_count')::integer;
    if v_app > 9999 or v_won + v_lost > v_app then
      raise exception 'Account outcomes exceed applications';
    end if;
    total_app := total_app + v_app;
    total_won := total_won + v_won;
    total_lost := total_lost + v_lost;
  end loop;
  -- Any remaining counts are explicitly "未割当" (historical/unassigned).
  if total_app > new.application_count
     or total_won > new.won_count
     or total_lost > new.lost_count
     or (new.won_count - total_won) + (new.lost_count - total_lost)
         > new.application_count - total_app then
    raise exception 'Per-account counts exceed aggregate totals';
  end if;
  return new;
end
$function$;

create trigger lottery_user_entries_verify_private_accounts
before insert or update of user_id, application_count, won_count, lost_count, account_entries
on public.lottery_user_entries for each row
execute function public.lottery_validate_private_account_entries();

create trigger lottery_external_user_entries_verify_private_accounts
before insert or update of user_id, application_count, won_count, lost_count, account_entries
on public.lottery_external_user_entries for each row
execute function public.lottery_validate_private_account_entries();

revoke all on function public.lottery_validate_private_account_entries() from public, anon;
-- Trigger runs with the invoking role; clients cannot execute it directly.
