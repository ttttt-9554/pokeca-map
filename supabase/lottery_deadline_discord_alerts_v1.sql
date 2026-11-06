-- Deadline reminders use the existing minute-by-minute lottery scan.
-- The delivery ledger is independent of the new-lottery Discord queue.
create table if not exists private.lottery_deadline_discord_deliveries (
  event_key text primary key,
  due_at timestamptz not null,
  claim_no integer not null,
  locked_until timestamptz not null,
  sent_at timestamptz
);
alter table private.lottery_deadline_discord_deliveries enable row level security;
revoke all on private.lottery_deadline_discord_deliveries from public, anon, authenticated;

create or replace function public.lottery_claim_deadline_discord_alerts(p_catalog jsonb)
returns table (
  event_key text, claim_no integer, event_url text, event_title text,
  store_name text, deadline timestamptz, reminder text
)
language sql
security definer
set search_path = ''
as $function$
  with clock as (
    select now() as checked_at
  ), published as (
    select distinct on (b.event_url) b.*
    from jsonb_to_recordset(p_catalog) as b(
      event_url text, identity text, origin text, event_title text, store_name text,
      deadline timestamptz, unavailable boolean, famima_verified boolean
    )
    where b.origin in ('livepocket', 'external')
    order by b.event_url, b.origin desc
  ), base as (
    select * from published
    union all
    select 'https://ttttt-9554.github.io/pokeca-map/?app_lottery=' || a.id,
      'app:' || a.id, 'app', a.event_title, coalesce(a.stores->0->>'name', a.store_name),
      a.application_end_at, false, false
    from public.lottery_app_events a
    where not a.is_hidden
  ), effective as (
    select distinct on (b.identity) b.identity, b.event_url,
      case when 'event_title' = any(c.edited_fields) then c.event_title
        else coalesce(nullif(e.event_title, ''), nullif(l.event_title, ''), b.event_title)
      end as event_title,
      case
        when 'stores' = any(c.edited_fields) then coalesce(c.stores_override, c.stores)->0->>'name'
        when 'store_name' = any(c.edited_fields) then c.store_name
        when e.event_url is null then b.store_name
        when b.famima_verified then coalesce(nullif(e.stores->0->>'name', ''), nullif(e.store_name, ''), b.store_name)
        else coalesce(e.stores->0->>'name', e.store_name)
      end as store_name,
      case
        when 'application_end_at' = any(c.edited_fields) then c.application_end_at
        when e.event_url is null then b.deadline
        when b.famima_verified then coalesce(e.application_end_at, b.deadline)
        else e.application_end_at
      end as deadline
    from base b
    left join public.lottery_card_overrides c on c.event_url = b.event_url
    left join public.lottery_external_event_overrides e on e.event_url = b.event_url and b.origin = 'external'
    left join public.livepocket_event_overrides l on l.event_url = b.event_url and b.origin = 'livepocket'
    where c.is_hidden is not true
      and e.state is distinct from 'excluded'
      and case when l.resolution in ('active', 'title') then true
        else l.resolution is distinct from 'unavailable' and b.unavailable is not true end
    order by b.identity, ('application_end_at' = any(c.edited_fields)) desc nulls last,
      (e.event_url is not null) desc, b.event_url
  ), due as (
    select e.*,
      md5(e.identity || ':' || extract(epoch from date_trunc('minute', e.deadline, 'UTC'))::bigint ||
        ':' || extract(epoch from date_trunc('minute', s.due_at, 'UTC'))::bigint) as event_key,
      s.due_at, s.reminder
    from effective e
    cross join clock t
    cross join lateral (
      select max(slot.at) as due_at,
        case when count(*) = 2 then 'both' else min(slot.kind) end as reminder
      from (values
        ((date_trunc('day', e.deadline at time zone 'Asia/Tokyo') + interval '7 hours') at time zone 'Asia/Tokyo', 'morning'),
        (e.deadline - interval '1 hour', 'one_hour')
      ) as slot(at, kind)
      where slot.at < e.deadline
      group by date_trunc('minute', slot.at, 'UTC')
    ) s
    where e.deadline > t.checked_at
      and s.due_at > t.checked_at - interval '10 minutes'
      and s.due_at <= t.checked_at
  ), ready as (
    select d.*
    from due d
    left join private.lottery_deadline_discord_deliveries q using (event_key)
    where q.event_key is null or (q.sent_at is null and q.locked_until <= now())
    order by d.due_at, d.deadline, d.event_key
    limit 80
  ), claimed as (
    insert into private.lottery_deadline_discord_deliveries as q(event_key, due_at, claim_no, locked_until)
    select r.event_key, r.due_at, 1, now() + interval '90 seconds' from ready r order by r.event_key
    on conflict (event_key) do update
      set claim_no = q.claim_no + 1, locked_until = excluded.locked_until
      where q.sent_at is null and q.locked_until <= now()
    returning q.event_key, q.claim_no
  )
  select c.event_key, c.claim_no, r.event_url, r.event_title, r.store_name, r.deadline, r.reminder
  from ready r join claimed c using (event_key)
  order by r.due_at, r.deadline, r.event_key;
$function$;

create or replace function public.lottery_settle_deadline_discord_alerts(p_claims jsonb, p_delivered boolean)
returns integer
language sql
security definer
set search_path = ''
as $function$
  with settled as (
    update private.lottery_deadline_discord_deliveries q
    set sent_at = case when p_delivered then now() else null end,
      locked_until = now() + interval '1 minute'
    from jsonb_to_recordset(p_claims) as claim(event_key text, claim_no integer)
    where q.event_key = claim.event_key and q.claim_no = claim.claim_no and q.sent_at is null
    returning q.event_key
  )
  select count(*)::integer from settled;
$function$;

revoke all on function public.lottery_claim_deadline_discord_alerts(jsonb),
  public.lottery_settle_deadline_discord_alerts(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.lottery_claim_deadline_discord_alerts(jsonb),
  public.lottery_settle_deadline_discord_alerts(jsonb, boolean) to service_role;
