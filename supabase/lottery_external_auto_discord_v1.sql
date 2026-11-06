-- First automatic confirmation of an external lottery uses the existing Discord queue.
-- Before deploying the scanner, seed the fully verified published events with
-- lottery_register_new_external(events, true) to avoid historical notices.
alter table public.lottery_discord_queue
  drop constraint if exists lottery_discord_queue_source_check,
  add constraint lottery_discord_queue_source_check
    check (source in ('app', 'livepocket', 'external_edit', 'external_auto'));

create table if not exists private.lottery_external_auto_seen (
  event_url text primary key,
  first_seen_at timestamptz not null default now()
);
alter table private.lottery_external_auto_seen enable row level security;
revoke all on private.lottery_external_auto_seen from public, anon, authenticated;

create or replace function public.lottery_register_new_external(
  p_events jsonb, p_seed boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  queued integer;
begin
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'Invalid external lottery event batch';
  end if;

  with candidates as (
    select distinct on (item->>'identity')
      item->>'identity' as identity,
      item->>'event_url' as event_url,
      item - 'identity' as payload
    from jsonb_array_elements(p_events) as item
    where char_length(item->>'identity') between 12 and 2000
      and item->>'event_url' ~ '^https?://[^[:space:]<>"]+$'
      and (p_seed or (item->>'application_end_at')::timestamptz > now())
    order by item->>'identity', item->>'event_url'
  ), first_confirmation as (
    insert into private.lottery_external_auto_seen(event_url)
    select identity from candidates
    order by identity
    on conflict do nothing
    returning event_url
  )
  insert into public.lottery_discord_queue(source, event_key, payload)
  select 'external_auto', md5(c.identity), c.payload
  from candidates c
  join first_confirmation f on f.event_url = c.identity
  where not p_seed
    -- A manual external row supplies the card's main fields. Its existing edit
    -- notification handles it. Card overrides may also hide or change those fields.
    and not exists (
      select 1 from public.lottery_external_event_overrides o where o.event_url = c.event_url
    )
    and not exists (
      select 1 from public.lottery_card_overrides o where o.event_url = c.event_url
        and (o.is_hidden or o.edited_fields && array[
          'event_title', 'store_name', 'prefecture', 'stores', 'application_start_at', 'application_end_at'
        ])
    )
  on conflict do nothing;
  get diagnostics queued = row_count;
  return queued;
end;
$function$;

revoke all on function public.lottery_register_new_external(jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.lottery_register_new_external(jsonb, boolean) to service_role;
