-- Developer-only guerrilla sale Discord delivery queue.
-- No webhook credentials are stored in SQL. Existing discord-notify Cron drains this queue.

create table if not exists public.guerrilla_sale_discord_queue(
  event_id uuid primary key references public.guerrilla_sale_events(id) on delete cascade,
  status text not null default 'pending'
    check(status in ('pending','sending','retry','sent','failed')),
  attempts integer not null default 0 check(attempts>=0),
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists guerrilla_sale_discord_queue_due_idx
  on public.guerrilla_sale_discord_queue(status,available_at,created_at);
alter table public.guerrilla_sale_discord_queue enable row level security;
revoke all on public.guerrilla_sale_discord_queue from public,anon,authenticated;
grant select,insert,update,delete on public.guerrilla_sale_discord_queue to service_role;

create or replace function private.guerrilla_sale_enqueue_discord()
returns trigger language plpgsql security definer set search_path=''
as $fn$
begin
  insert into public.guerrilla_sale_discord_queue(event_id)
  values(new.id) on conflict(event_id) do nothing;
  return null;
end;
$fn$;
revoke all on function private.guerrilla_sale_enqueue_discord() from public,anon,authenticated;

drop trigger if exists guerrilla_sale_discord_enqueue on public.guerrilla_sale_events;
create trigger guerrilla_sale_discord_enqueue
after insert on public.guerrilla_sale_events
for each row execute function private.guerrilla_sale_enqueue_discord();

create or replace function public.guerrilla_sale_claim_discord_notifications(p_limit integer default 5)
returns table(event_id uuid,attempts integer)
language sql security definer set search_path=''
as $fn$
  with eligible as (
    select q.event_id
    from public.guerrilla_sale_discord_queue q
    where (q.status in ('pending','retry') and q.available_at<=now())
       or (q.status='sending' and q.locked_until<now())
    order by q.available_at,q.created_at
    for update skip locked
    limit least(greatest(p_limit,1),5)
  )
  update public.guerrilla_sale_discord_queue q
  set status='sending',attempts=q.attempts+1,
      locked_until=now()+interval '3 minutes',last_error=null
  from eligible e where q.event_id=e.event_id
  returning q.event_id,q.attempts;
$fn$;
revoke all on function public.guerrilla_sale_claim_discord_notifications(integer)
  from public,anon,authenticated;
grant execute on function public.guerrilla_sale_claim_discord_notifications(integer)
  to service_role;

create or replace function public.guerrilla_sale_settle_discord_notification(
  p_event_id uuid,p_attempts integer,p_sent boolean,p_error text,
  p_retry_seconds integer default 60
)
returns boolean language plpgsql security definer set search_path=''
as $fn$
declare affected integer;
begin
  update public.guerrilla_sale_discord_queue q
  set status=case when p_sent then 'sent'
                  when q.attempts>=12 then 'failed' else 'retry' end,
      locked_until=null,
      sent_at=case when p_sent then now() else q.sent_at end,
      available_at=case when p_sent then now() else
        now()+make_interval(secs=>least(greatest(p_retry_seconds,60),3600)) end,
      last_error=case when p_sent then null else left(coalesce(p_error,'Unknown error'),500) end
  where q.event_id=p_event_id
    and q.status='sending' and q.attempts=p_attempts;
  get diagnostics affected=row_count;
  return affected=1;
end;
$fn$;
revoke all on function public.guerrilla_sale_settle_discord_notification(uuid,integer,boolean,text,integer)
  from public,anon,authenticated;
grant execute on function public.guerrilla_sale_settle_discord_notification(uuid,integer,boolean,text,integer)
  to service_role;
