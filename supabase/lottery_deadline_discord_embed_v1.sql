-- Reuse the existing eligibility, schedule and delivery lease.
-- Add the public card fields used by the Discord embed in the same request.
create or replace function public.lottery_claim_deadline_discord_embeds(p_catalog jsonb)
returns table (
  event_key text, claim_no integer, event_url text, event_title text,
  store_name text, deadline timestamptz, reminder text, origin text,
  app_id text, app_name text, registration_method text, product_name text,
  prefecture text, stores jsonb, application_start_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  with claimed as materialized (
    select * from public.lottery_claim_deadline_discord_alerts(p_catalog)
  ), published as (
    select distinct on (b.event_url) b.*
    from jsonb_to_recordset(p_catalog) as b(
      event_url text, origin text, product_name text, prefecture text, stores jsonb,
      application_start_at timestamptz, famima_verified boolean
    )
    where b.origin in ('livepocket', 'external')
      and b.event_url in (select d.event_url from claimed d)
    order by b.event_url, b.origin desc
  )
  select d.event_key, d.claim_no, d.event_url, d.event_title,
    case
      when selected.has_card_stores or jsonb_array_length(selected.stores) > 1 then selected.stores->0->>'name'
      when 'store_name' = any(c.edited_fields) then c.store_name
      else coalesce(nullif(l.store_name, ''), d.store_name)
    end as store_name,
    d.deadline, d.reminder, case when a.id is not null then 'app' else b.origin end,
    a.id::text, a.app_name, a.registration_method,
    case when 'product_name' = any(c.edited_fields) then c.product_name
      else coalesce(a.product_name, b.product_name) end,
    case
      when selected.has_card_stores then selected.stores->0->>'prefecture'
      when jsonb_array_length(selected.stores) <= 1 and 'prefecture' = any(c.edited_fields) then c.prefecture
      else coalesce(nullif(l.prefecture, ''), nullif(selected.stores->0->>'prefecture', ''), legacy.prefecture)
    end as prefecture,
    selected.stores,
    case
      when 'application_start_at' = any(c.edited_fields) then c.application_start_at
      when e.event_url is not null and b.famima_verified is not true then e.application_start_at
      else coalesce(e.application_start_at, a.application_start_at, b.application_start_at)
    end
  from claimed d
  left join published b on b.event_url = d.event_url
  left join public.lottery_app_events a
    on a.id = substring(d.event_url from '^https://ttttt-9554[.]github[.]io/pokeca-map/[?]app_lottery=([a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12})$')::uuid
  left join public.lottery_card_overrides c on c.event_url = d.event_url
  left join public.lottery_external_event_overrides e on e.event_url = d.event_url and b.origin = 'external'
  cross join lateral (
    select coalesce(
      case when e.event_url is not null then e.stores else coalesce(a.stores, b.stores) end, '[]'::jsonb
    ) as stores,
    case
      when e.event_url is null then coalesce(a.prefecture, b.prefecture)
      when b.famima_verified then coalesce(nullif(e.prefecture, ''), b.prefecture)
      else e.prefecture
    end as prefecture
  ) legacy
  left join public.livepocket_location_overrides l
    on l.event_url = d.event_url and b.origin = 'livepocket' and jsonb_array_length(legacy.stores) <= 1
  cross join lateral (
    select ('stores' = any(c.edited_fields) and coalesce(c.stores_override, c.stores) is not null) as has_card_stores,
      case when 'stores' = any(c.edited_fields) then coalesce(c.stores_override, c.stores, legacy.stores)
        else legacy.stores end as stores
  ) selected
  order by d.deadline, d.event_key;
$function$;

revoke all on function public.lottery_claim_deadline_discord_embeds(jsonb) from public, anon, authenticated;
grant execute on function public.lottery_claim_deadline_discord_embeds(jsonb) to service_role;
