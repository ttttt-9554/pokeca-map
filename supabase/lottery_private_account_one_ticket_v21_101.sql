-- Toreca Radar v21.101: a single ticket per private application account.
-- Existing entries have been checked for compatibility before activation.
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
    if v_app <> 1 or v_won > 1 or v_lost > 1 or v_won + v_lost > 1 then
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


-- Preserve the prior owner-only RLS policies and existing account profiles.
