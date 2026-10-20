-- v21.45 / Direct Save LivePocket overrides
-- Run once in Supabase Dashboard > SQL Editor.
-- Supabase Auth JWT identity is checked by Postgres RLS (not JavaScript).
create table if not exists public.livepocket_event_overrides (
  event_url text primary key,
  resolution text not null check (resolution in ('title','unavailable','active')),
  event_title text,
  reason text,
  evidence text not null,
  updated_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint livepocket_override_exact_url check (
    event_url ~ '^https://livepocket[.]jp/e/[A-Za-z0-9_-]{4,64}$'
  ),
  constraint livepocket_override_valid_payload check (
    (
      resolution='title'
      and event_title is not null
      and length(btrim(event_title)) between 5 and 160
      and reason is null
      and evidence in ('official_page_viewed','official_screenshot_viewed')
    ) or (
      resolution='unavailable'
      and event_title is null
      and reason in ('not_found_404_410','official_removed_notice')
      and (
        (reason='not_found_404_410' and evidence='observed_404_410')
        or (reason='official_removed_notice' and evidence='official_notice_viewed')
      )
    ) or (
      resolution='active'
      and event_title is null and reason is null
      and evidence='official_page_reopened'
    )
  )
);
create or replace function public.livepocket_override_stamp()
returns trigger language plpgsql security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'User must be authenticated';
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists livepocket_override_stamp on public.livepocket_event_overrides;
create trigger livepocket_override_stamp
before insert or update on public.livepocket_event_overrides
for each row execute function public.livepocket_override_stamp();

alter table public.livepocket_event_overrides enable row level security;
drop policy if exists livepocket_override_public_select on public.livepocket_event_overrides;
create policy livepocket_override_public_select
on public.livepocket_event_overrides for select
to anon, authenticated using (true);

drop policy if exists livepocket_override_developer_insert on public.livepocket_event_overrides;
create policy livepocket_override_developer_insert
on public.livepocket_event_overrides for insert
to authenticated
with check (auth.uid() = '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid);

drop policy if exists livepocket_override_developer_update on public.livepocket_event_overrides;
create policy livepocket_override_developer_update
on public.livepocket_event_overrides for update
to authenticated
using (auth.uid() = '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid)
with check (auth.uid() = '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid);

drop policy if exists livepocket_override_developer_delete on public.livepocket_event_overrides;
create policy livepocket_override_developer_delete
on public.livepocket_event_overrides for delete
to authenticated using (auth.uid() = '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid);

revoke all on public.livepocket_event_overrides from anon, authenticated;
grant select on public.livepocket_event_overrides to anon, authenticated;
grant insert, update, delete on public.livepocket_event_overrides to authenticated;

-- Public reads expose only event information; never store private account data.
-- Keep 'pending' local to the developer's iPhone, not in this public table.
