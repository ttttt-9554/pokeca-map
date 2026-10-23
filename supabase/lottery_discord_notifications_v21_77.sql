-- v21.77: Discord notification queue for newly added app and LivePocket lotteries.
-- Run after supabase/discord_notification_queue_v21_49.sql.
-- Applied to Supabase on 2026-10-23.
-- No old event is backfilled: seed lottery_livepocket_seen with the CURRENT
-- public LivePocket URL catalog before enabling the scan Cron.
-- This file contains no Discord credentials; server-only signing is via Vault.

create table if not exists public.lottery_discord_queue(
  source text not null check(source in ('app','livepocket')),
  event_key text not null check(char_length(event_key) between 4 and 220),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check(status in ('pending','sending','retry','sent','failed')),
  attempts integer not null default 0 check(attempts>=0),
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(source,event_key)
);
create index if not exists lottery_discord_queue_due_idx
  on public.lottery_discord_queue(status,available_at,created_at);
alter table public.lottery_discord_queue enable row level security;
revoke all on public.lottery_discord_queue from public,anon,authenticated;
grant select,insert,update,delete on public.lottery_discord_queue to service_role;

create table if not exists public.lottery_livepocket_seen(
  event_url text primary key
    check(event_url ~ '^https://livepocket[.]jp/e/[A-Za-z0-9_-]{4,64}$'),
  first_seen_at timestamptz not null default now()
);
alter table public.lottery_livepocket_seen enable row level security;
revoke all on public.lottery_livepocket_seen from public,anon,authenticated;
grant select,insert on public.lottery_livepocket_seen to service_role;

-- The Edge Function reads app event visibility using service-role credentials.
grant select on public.lottery_app_events to service_role;

create or replace function private.lottery_discord_enqueue_app()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  if new.is_hidden is false then
    insert into public.lottery_discord_queue(source,event_key,payload)
    values('app',new.id::text,jsonb_build_object(
      'id',new.id,'app_name',left(new.app_name,100),
      'event_title',left(new.event_title,200),
      'product_name',left(coalesce(new.product_name,''),200),
      'store_name',left(coalesce(new.store_name,''),200),
      'prefecture',left(coalesce(new.prefecture,''),40),
      'application_start_at',new.application_start_at,
      'application_end_at',new.application_end_at
    )) on conflict(source,event_key) do nothing;
  end if;
  return null;
end;
$fn$;
drop trigger if exists lottery_discord_enqueue_app on public.lottery_app_events;
create trigger lottery_discord_enqueue_app
  after insert on public.lottery_app_events
  for each row execute function private.lottery_discord_enqueue_app();

create or replace function public.lottery_register_new_livepocket(p_events jsonb)
returns integer language plpgsql security definer set search_path='' as $fn$
declare item jsonb;
declare url text;
declare n integer:=0;
declare inserted integer;
begin
  if jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>2500
    then raise exception 'Invalid LivePocket event batch';
  end if;
  perform pg_advisory_xact_lock(2026,1023);
  for item in select value from jsonb_array_elements(p_events) loop
    url=item->>'url';
    if url is null or url !~ '^https://livepocket[.]jp/e/[A-Za-z0-9_-]{4,64}$'
      then continue; end if;
    insert into public.lottery_livepocket_seen(event_url)
      values(url) on conflict do nothing;
    get diagnostics inserted=row_count;
    if inserted=1 then
      insert into public.lottery_discord_queue(source,event_key,payload)
      values('livepocket',url,jsonb_build_object(
        'url',url,
        'event_title',left(coalesce(item->>'event_title',''),200),
        'product_name',left(coalesce(item->>'product_name',''),200),
        'store_name',left(coalesce(item->>'store_name',''),200),
        'prefecture',left(coalesce(item->>'prefecture',''),40),
        'application_start_at',item->>'application_start_at',
        'application_end_at',item->>'application_end_at'
      )) on conflict do nothing;
      n:=n+1;
    end if;
  end loop;
  return n;
end;
$fn$;
revoke all on function public.lottery_register_new_livepocket(jsonb)
  from public,anon,authenticated;
grant execute on function public.lottery_register_new_livepocket(jsonb)
  to service_role;

create or replace function public.lottery_claim_discord_notifications(p_limit integer default 5)
returns table(source text,event_key text,payload jsonb,attempts integer)
language sql security definer set search_path='' as $fn$
  with eligible as (
    select q.source,q.event_key
    from public.lottery_discord_queue q
    where (q.status in ('pending','retry') and q.available_at<=now())
       or (q.status='sending' and q.locked_until<now())
    order by q.available_at,q.created_at
    for update skip locked
    limit least(greatest(p_limit,1),5)
  )
  update public.lottery_discord_queue q
  set status='sending',attempts=q.attempts+1,
      locked_until=now()+interval '3 minutes',last_error=null
  from eligible e where q.source=e.source and q.event_key=e.event_key
  returning q.source,q.event_key,q.payload,q.attempts;
$fn$;
revoke all on function public.lottery_claim_discord_notifications(integer)
  from public,anon,authenticated;
grant execute on function public.lottery_claim_discord_notifications(integer)
  to service_role;

create or replace function public.lottery_settle_discord_notification(
  p_source text,p_event_key text,p_attempts integer,p_sent boolean,
  p_error text,p_retry_seconds integer default 60
)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare affected integer;
begin
  update public.lottery_discord_queue q
  set status=case when p_sent then 'sent'
      when q.attempts>=12 then 'failed' else 'retry' end,
      locked_until=null,
      sent_at=case when p_sent then now() else q.sent_at end,
      available_at=case when p_sent then now() else
        now()+make_interval(secs=>least(greatest(p_retry_seconds,60),3600)) end,
      last_error=case when p_sent then null
        else left(coalesce(p_error,'Unknown error'),500) end
  where q.source=p_source and q.event_key=p_event_key
    and q.status='sending' and q.attempts=p_attempts;
  get diagnostics affected=row_count;
  return affected=1;
end;
$fn$;
revoke all on function public.lottery_settle_discord_notification(
  text,text,integer,boolean,text,integer) from public,anon,authenticated;
grant execute on function public.lottery_settle_discord_notification(
  text,text,integer,boolean,text,integer) to service_role;

-- Deploy updated supabase/functions/discord-notify/index.ts BEFORE scheduling.
-- Supabase Cron sends a signed request to the same existing Edge Function.
-- The existing v21.49 minute-by-minute DRAIN task delivers queued notices.
select cron.schedule('lottery_livepocket_scan_v21_77','*/5 * * * *',$cmd$
  select net.http_post(
    url:='https://aypcmtlaaygmiexboypk.supabase.co/functions/v1/discord-notify',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets
        where name='discord_notification_dispatch_key')
    ),
    body:='{"type":"LOTTERY_SCAN"}'::jsonb,
    timeout_milliseconds:=45000
  );
$cmd$);
