-- v21.48: per-event manually verified location overrides.
-- Separate table: event title / page-availability corrections remain untouched.
create table if not exists public.livepocket_location_overrides (
  event_url text primary key,
  store_name text,
  prefecture text,
  evidence text not null,
  updated_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint lp_location_exact_event_url check (
    event_url ~ '^https://livepocket[.]jp/e/[A-Za-z0-9_-]{4,64}$'
  ),
  constraint lp_location_has_field check (
    store_name is not null or prefecture is not null
  ),
  constraint lp_location_store_name_valid check (
    store_name is null or (
      length(btrim(store_name)) between 2 and 160
      and store_name=btrim(store_name)
      and store_name !~ '[[:cntrl:]]'
    )
  ),
  constraint lp_location_prefecture_valid check (
    prefecture is null or prefecture in (
      '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
      '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
      '新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県',
      '静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県',
      '奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県',
      '徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県',
      '熊本県','大分県','宮崎県','鹿児島県','沖縄県'
    )
  ),
  constraint lp_location_evidence_valid check (
    evidence in ('official_page_viewed','official_screenshot_viewed','official_store_notice_viewed')
  )
);
create or replace function public.livepocket_location_stamp()
returns trigger language plpgsql security invoker
set search_path=public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authenticated developer session required';
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists livepocket_location_stamp on public.livepocket_location_overrides;
create trigger livepocket_location_stamp
before insert or update on public.livepocket_location_overrides
for each row execute function public.livepocket_location_stamp();
alter table public.livepocket_location_overrides enable row level security;
drop policy if exists lp_location_public_select on public.livepocket_location_overrides;
create policy lp_location_public_select on public.livepocket_location_overrides
for select to anon,authenticated using (true);
drop policy if exists lp_location_developer_insert on public.livepocket_location_overrides;
create policy lp_location_developer_insert on public.livepocket_location_overrides
for insert to authenticated
with check (auth.uid()='0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid);
drop policy if exists lp_location_developer_update on public.livepocket_location_overrides;
create policy lp_location_developer_update on public.livepocket_location_overrides
for update to authenticated
using (auth.uid()='0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid)
with check (auth.uid()='0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid);
drop policy if exists lp_location_developer_delete on public.livepocket_location_overrides;
create policy lp_location_developer_delete on public.livepocket_location_overrides
for delete to authenticated
using (auth.uid()='0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid);
revoke all on public.livepocket_location_overrides from anon,authenticated;
grant select on public.livepocket_location_overrides to anon,authenticated;
grant insert,update,delete on public.livepocket_location_overrides to authenticated;
