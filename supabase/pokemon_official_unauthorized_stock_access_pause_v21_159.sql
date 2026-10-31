-- v21.159: Official Pokemon Center Online terms ban automated stock
-- extraction and crawling. Pause just this retailer and its minute-by-minute
-- cron; keep Amenity Dream and other monitors running. Re-enable only with
-- documented permission and an authorized stock feed.
UPDATE public.guerrilla_sale_monitor_targets
 SET enabled=false,updated_at=now()
 WHERE site_key='pokemon' AND enabled IS TRUE;
UPDATE public.guerrilla_fast_state
 SET last_status='paused',
     last_error='official_terms_no_automated_stock_access',
     cooldown_until=NULL
 WHERE site_key='pokemon';
DO $body$
DECLARE j integer;
BEGIN
 FOR j IN SELECT jobid FROM cron.job WHERE jobname='pokemon_fast_monitor_v1'
 LOOP
   PERFORM cron.unschedule(j);
 END LOOP;
END;
$body$;
