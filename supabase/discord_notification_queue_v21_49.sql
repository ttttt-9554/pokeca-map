-- v21.49: durable shared-report Discord notification queue.
-- This migration never embeds any webhook key: it transfers the pre-existing
-- trigger header into Supabase Vault before replacing the legacy trigger.
-- Existing shared_reports are NOT backfilled, preventing duplicate alerts.

create table if not exists public.discord_notification_queue(
  report_id uuid primary key references public.shared_reports(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','sending','retry','sent')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists discord_notification_due_idx
  on public.discord_notification_queue(status,available_at,created_at);
alter table public.discord_notification_queue enable row level security;
revoke all on public.discord_notification_queue from public,anon,authenticated;
grant select,insert,update,delete on public.discord_notification_queue to service_role;

create or replace function public.discord_enqueue_report()
returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  insert into public.discord_notification_queue(report_id)
  values (new.id) on conflict (report_id) do nothing;
  return new;
end;
$$;
revoke all on function public.discord_enqueue_report() from public,anon,authenticated;

create or replace function public.discord_claim_notifications(p_limit integer default 10)
returns table(report_id uuid,attempts integer)
language sql security definer set search_path=''
as $$
  with eligible as (
    select q.report_id from public.discord_notification_queue q
    where (q.status in ('pending','retry') and q.available_at <= now())
      or (q.status='sending' and q.locked_until < now())
    order by q.available_at,q.created_at
    for update skip locked limit least(greatest(p_limit,1),10)
  )
  update public.discord_notification_queue q
  set status='sending', attempts=q.attempts+1,
      locked_until=now()+interval '3 minutes',last_error=null
  from eligible e where q.report_id=e.report_id
  returning q.report_id,q.attempts;
$$;
revoke all on function public.discord_claim_notifications(integer) from public,anon,authenticated;
grant execute on function public.discord_claim_notifications(integer) to service_role;

create or replace function public.discord_settle_notification(
  p_report_id uuid,p_attempts integer,p_sent boolean,p_error text,
  p_retry_seconds integer default 60
)
returns boolean language plpgsql security definer
set search_path='' as $$
declare updated_count integer;
begin
  update public.discord_notification_queue q
  set status=case when p_sent then 'sent' else 'retry' end,
      locked_until=null,
      sent_at=case when p_sent then now() else q.sent_at end,
      available_at=case when p_sent then now() else
        now()+make_interval(secs=>least(greatest(p_retry_seconds,60),3600)) end,
      last_error=case when p_sent then null else left(coalesce(p_error,'Unknown error'),500) end
  where q.report_id=p_report_id
    and q.status='sending' and q.attempts=p_attempts;
  get diagnostics updated_count=row_count;
  return updated_count=1;
end;
$$;
revoke all on function public.discord_settle_notification(uuid,integer,boolean,text,integer)
  from public,anon,authenticated;
grant execute on function public.discord_settle_notification(uuid,integer,boolean,text,integer)
  to service_role;

-- Save the existing shared webhook signing secret to Vault without logging it,
-- and do not change the existing Edge Function's NOTIFY_SECRET setting.
do $$
declare legacy_secret text;
begin
  if not exists (select 1 from vault.secrets where name='discord_notification_dispatch_key') then
    select (regexp_match(pg_get_triggerdef(t.oid),
      '"x-notify-secret"[[:space:]]*:[[:space:]]*"([^"]+)"'))[1]
    into legacy_secret
    from pg_trigger t where t.tgrelid='public.shared_reports'::regclass
      and t.tgname='notify-discord-on-report';
    if legacy_secret is null or length(legacy_secret) < 24 then
      raise exception 'Existing Discord webhook signing key cannot be migrated safely';
    end if;
    perform vault.create_secret(legacy_secret,'discord_notification_dispatch_key',
      'Server-only signed call for Discord notification queue draining');
  end if;
end;
$$;

drop trigger if exists "notify-discord-on-report" on public.shared_reports;
drop trigger if exists discord_notification_enqueue on public.shared_reports;
create trigger discord_notification_enqueue
after insert on public.shared_reports
for each row execute function public.discord_enqueue_report();

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('discord_notification_drain_v21_49','* * * * *',$cmd$
  select net.http_post(
    url:='https://aypcmtlaaygmiexboypk.supabase.co/functions/v1/discord-notify',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-notify-secret',
      (select decrypted_secret from vault.decrypted_secrets
       where name='discord_notification_dispatch_key')),
    body:='{"type":"DRAIN"}'::jsonb,
    timeout_milliseconds:=55000
  );
$cmd$);
