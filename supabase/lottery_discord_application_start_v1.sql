-- Keep existing registration deduplication. Refresh the application window
-- for unsent catalog notices when the collector publishes corrections.
create or replace function public.lottery_register_discord_catalog(p_source text, p_events jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  queued integer;
begin
  case p_source
    when 'livepocket' then queued := public.lottery_register_new_livepocket(p_events);
    when 'external_auto' then queued := public.lottery_register_new_external(p_events);
    else raise exception 'Invalid lottery catalog source';
  end case;

  with catalog as (
    select case when p_source = 'livepocket' then item->>'url' else md5(item->>'identity') end as event_key,
      jsonb_build_object(
        'application_start_at', item->>'application_start_at',
        'application_end_at', item->>'application_end_at',
        'manual_page_unavailable', coalesce(item->'manual_page_unavailable' = 'true'::jsonb, false)
      ) as timing
    from jsonb_array_elements(p_events) as item
  )
  update public.lottery_discord_queue q
  set payload = q.payload || c.timing
  from catalog c
  where q.source = p_source and q.event_key = c.event_key
    and (q.status in ('pending', 'retry') or (q.status = 'sending' and q.locked_until < now()))
    and q.payload is distinct from q.payload || c.timing;

  return queued;
end;
$function$;

revoke all on function public.lottery_register_discord_catalog(text, jsonb) from public, anon, authenticated;
grant execute on function public.lottery_register_discord_catalog(text, jsonb) to service_role;

-- Eligibility is shared by the immediate and scheduled drains. Keep the
-- retry clock independent from the editable application window.
create or replace function public.lottery_claim_discord_notifications(p_limit integer default 5)
returns table (source text, event_key text, payload jsonb, attempts integer)
language sql
security definer
set search_path = ''
as $function$
  with eligible as (
    select q.source, q.event_key, kind.is_registration, dates.start_at, dates.end_at, card.is_hidden
    from public.lottery_discord_queue q
    left join public.lottery_app_events a
      on a.id = case when q.source = 'app' and q.event_key ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
        then q.event_key::uuid end
    left join public.lottery_card_overrides c on c.event_url = case q.source
      when 'app' then 'https://ttttt-9554.github.io/pokeca-map/?app_lottery=' || q.event_key
      when 'livepocket' then q.event_key
      when 'external_auto' then q.payload->>'event_url'
    end
    left join public.livepocket_event_overrides l on q.source = 'livepocket' and l.event_url = q.event_key
    cross join lateral (
      select q.source in ('app', 'livepocket', 'external_auto') as is_registration
    ) kind
    cross join lateral (
      select
        case when 'application_start_at' = any(c.edited_fields) then c.application_start_at
          when q.source = 'app' then a.application_start_at
          when pg_input_is_valid(q.payload->>'application_start_at', 'timestamp with time zone')
            then (q.payload->>'application_start_at')::timestamptz
        end as start_at,
        case when 'application_end_at' = any(c.edited_fields) then c.application_end_at
          when q.source = 'app' then a.application_end_at
          when pg_input_is_valid(q.payload->>'application_end_at', 'timestamp with time zone')
            then (q.payload->>'application_end_at')::timestamptz
        end as end_at
    ) dates
    cross join lateral (
      select c.is_hidden is true
        or (q.source = 'app' and (a.id is null or a.is_hidden))
        or (q.source = 'livepocket' and
          (l.resolution is not distinct from 'unavailable'
            or (l.resolution is null and q.payload->'manual_page_unavailable' is not distinct from 'true'::jsonb)))
        as is_hidden
    ) card
    where ((q.status in ('pending', 'retry') and q.available_at <= now())
      or (q.status = 'sending' and q.locked_until < now()))
      and (not kind.is_registration or dates.start_at is null or dates.start_at <= now()
        or dates.end_at <= now() or card.is_hidden)
    order by q.available_at, q.created_at
    for update of q skip locked
    limit least(greatest(p_limit, 1), 5)
  )
  update public.lottery_discord_queue q
  set status = 'sending', attempts = q.attempts + 1,
      locked_until = now() + interval '3 minutes', last_error = null
  from eligible e where q.source = e.source and q.event_key = e.event_key
  returning q.source, q.event_key,
    case when e.is_registration then q.payload || jsonb_build_object(
      'application_start_at', e.start_at,
      'application_end_at', e.end_at,
      'notify_application_started', coalesce(e.start_at > q.created_at, false),
      'skip_new_notification', e.is_hidden or coalesce(e.end_at <= now(), false)
    ) else q.payload end,
    q.attempts;
$function$;

revoke all on function public.lottery_claim_discord_notifications(integer) from public, anon, authenticated;
grant execute on function public.lottery_claim_discord_notifications(integer) to service_role;
