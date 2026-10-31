-- Bic Camera monitor beta. No crawl is enabled by default.
-- Preserve existing developer-only RLS; allow exactly the documented official URL shapes.
ALTER TABLE public.guerrilla_sale_monitor_targets DROP CONSTRAINT IF EXISTS guerrilla_site_key_check;
ALTER TABLE public.guerrilla_sale_monitor_targets ADD CONSTRAINT guerrilla_site_key_check CHECK (site_key IN ('pokemon','amenity','biccamera'));
ALTER TABLE public.guerrilla_sale_monitor_targets DROP CONSTRAINT IF EXISTS guerrilla_target_url_check;
ALTER TABLE public.guerrilla_sale_monitor_targets ADD CONSTRAINT guerrilla_target_url_check CHECK (
    (site_key='pokemon' AND (
       (mode='all' AND url IN ('https://www.pokemoncenter-online.com/search/','https://www.pokemoncenter-online.com/pokemon-card-game/'))
       OR (mode='selected' AND url ~ '^https://www[.]pokemoncenter-online[.]com/[0-9]{6,20}(-[A-Za-z0-9_-]+)?[.]html$')))
    OR (site_key='amenity' AND (
       (mode='all' AND url='https://www.amenitydream.com/product-list')
       OR (mode='selected' AND url ~ '^https://www[.]amenitydream[.]com/product/[0-9]+$')))
    OR (site_key='biccamera' AND (
       (mode='all' AND url='https://www.biccamera.com/bc/category/001/220/070/')
       OR (mode='selected' AND url ~ '^https://www[.]biccamera[.]com/bc/item/[0-9]{5,12}/$')))
);
ALTER TABLE public.guerrilla_sale_products DROP CONSTRAINT IF EXISTS guerrilla_sale_products_site_key_check;
ALTER TABLE public.guerrilla_sale_products ADD CONSTRAINT guerrilla_sale_products_site_key_check CHECK (site_key IN ('pokemon','amenity','biccamera'));
-- Existing stored procedure is preserved in full, only expanding site key allowlist.
CREATE OR REPLACE FUNCTION public.guerrilla_sale_observe(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v jsonb;
  old public.guerrilla_sale_products%rowtype;
  stamp timestamptz:=clock_timestamp();
  emitted integer:=0;
  known boolean;
  fresh boolean;
  eligible boolean;
  kind text;
  gap integer;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>200 then
   raise exception 'invalid observation batch';
 end if;
 for v in select value from jsonb_array_elements(p_rows) loop
  if v->>'site_key' not in ('pokemon','amenity','biccamera') or v->>'id' !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid observation identity';
  end if;
  insert into public.guerrilla_sale_products(id,site_key,url,product)
  values(v->>'id',v->>'site_key',v->>'url',left(coalesce(v->>'product',''),500))
  on conflict(id) do nothing;

  select * into old
  from public.guerrilla_sale_products
  where id=v->>'id'
  for update;

  if old.url<>v->>'url' or old.site_key<>v->>'site_key' then
    raise exception 'observation identity mismatch';
  end if;

  known:=v->>'status' in ('available','unavailable');
  fresh:=old.checked_at is null;
  eligible:=coalesce((v->>'notification_eligible')::boolean,false);
  gap:=greatest(15,least(10080,coalesce((v->>'cooldown_minutes')::integer,60)));
  kind:=null;

  if eligible
     and v->>'status'='available'
     and (old.last_alert_at is null or old.last_alert_at<=stamp-make_interval(mins=>gap))
  then
   if old.confirmed_status='unavailable' then
     kind:='restock';
   elsif fresh and coalesce((v->>'notify_new')::boolean,false) then
     kind:='new_product';
   end if;
  end if;

  update public.guerrilla_sale_products set
    product=case when coalesce(v->>'product','')<>'' then left(v->>'product',500) else product end,
    status=case when v->>'status'='unobserved' then status else v->>'status' end,
    confirmed_status=case when known then v->>'status' else confirmed_status end,
    reason=left(coalesce(v->>'reason',''),200),
    scopes=array(
      select distinct s
      from unnest(old.scopes || array(
        select jsonb_array_elements_text(coalesce(v->'scopes','[]'::jsonb))
      )) s
    ),
    last_seen_at=stamp,
    checked_at=case when v->>'status'='unobserved' then checked_at else stamp end,
    last_alert_at=case when kind is not null then stamp else last_alert_at end
  where id=old.id;

  if kind is not null then
   insert into public.guerrilla_sale_events(product_id,site_key,url,product,scopes,kind,detected_at)
   select id,site_key,url,product,scopes,kind,stamp
   from public.guerrilla_sale_products
   where id=old.id;
   emitted:=emitted+1;
  end if;
 end loop;
 return emitted;
end;
$function$;
INSERT INTO public.guerrilla_sale_monitor_targets
    (id,site_key,mode,shop,product,url,enabled,available_text,unavailable_text,required_text)
VALUES
    ('biccamera-catalog','biccamera','all','ビックカメラ.com',
     'トレーディングカード一覧（先頭ページ）',
     'https://www.biccamera.com/bc/category/001/220/070/',false,
     ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[])
ON CONFLICT (id) DO NOTHING;
