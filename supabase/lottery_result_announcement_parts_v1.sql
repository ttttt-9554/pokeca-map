-- Keep date-only announcements without assigning a clock time.
alter table public.lottery_user_entries
  add column if not exists result_announcement_date date,
  add column if not exists result_announcement_time time without time zone;

alter table public.lottery_external_user_entries
  add column if not exists result_announcement_date date,
  add column if not exists result_announcement_time time without time zone;

create or replace function private.lottery_sync_result_schedule_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.result_announcement_date is not distinct from old.result_announcement_date
      and new.result_announcement_time is not distinct from old.result_announcement_time then
      if new.result_announcement_at is distinct from old.result_announcement_at then
        new.result_announcement_date := new.result_announcement_at::date;
        new.result_announcement_time := new.result_announcement_at::time;
      end if;
      return new;
    end if;
  elsif new.result_announcement_date is null and new.result_announcement_time is null then
    new.result_announcement_date := new.result_announcement_at::date;
    new.result_announcement_time := new.result_announcement_at::time;
    return new;
  end if;

  if new.result_announcement_date is null then
    new.result_announcement_time := null;
  end if;
  new.result_announcement_at := new.result_announcement_date + new.result_announcement_time;
  return new;
end;
$$;

revoke execute on function private.lottery_sync_result_schedule_v1()
  from public, anon, authenticated;

create or replace trigger lottery_sync_result_schedule_v1
before insert or update of result_announcement_at, result_announcement_date, result_announcement_time
on public.lottery_user_entries
for each row execute function private.lottery_sync_result_schedule_v1();

create or replace trigger lottery_sync_result_schedule_v1
before insert or update of result_announcement_at, result_announcement_date, result_announcement_time
on public.lottery_external_user_entries
for each row execute function private.lottery_sync_result_schedule_v1();

notify pgrst, 'reload schema';
