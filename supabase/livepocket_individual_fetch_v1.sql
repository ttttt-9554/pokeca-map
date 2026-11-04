-- Private queue for one administrator-requested LivePocket recheck.
-- Collector uses its existing browser, access-block handling and schedule.
CREATE SCHEMA IF NOT EXISTS individual_lottery_private;
REVOKE ALL ON SCHEMA individual_lottery_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA individual_lottery_private TO authenticated, service_role;
CREATE TABLE IF NOT EXISTS individual_lottery_private.requests (
  event_url text PRIMARY KEY,
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','success','blocked','unavailable','error')),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  message text NOT NULL DEFAULT '',
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz
);
ALTER TABLE individual_lottery_private.requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON individual_lottery_private.requests FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION individual_lottery_private.request_one(p_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF (SELECT auth.uid()) IS DISTINCT FROM '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 IF p_url IS NULL OR p_url !~ '^https://livepocket[.]jp/e/[A-Za-z0-9_-]{4,64}$' THEN
   RAISE EXCEPTION 'Invalid LivePocket URL' USING ERRCODE='22023';
 END IF;
 IF (SELECT count(*) FROM individual_lottery_private.requests
     WHERE status IN ('pending','running') AND event_url<>p_url) >= 5 THEN
   RAISE EXCEPTION 'Too many pending requests' USING ERRCODE='P0001';
 END IF;
 INSERT INTO individual_lottery_private.requests(event_url) VALUES(p_url)
 ON CONFLICT(event_url) DO UPDATE SET request_id=gen_random_uuid(),status='pending',
   fields='{}'::jsonb,message='',requested_at=now(),updated_at=now(),started_at=NULL
 WHERE individual_lottery_private.requests.status NOT IN ('pending','running')
    OR individual_lottery_private.requests.updated_at < now()-interval '30 minutes';
 SELECT pg_catalog.jsonb_build_object('url',r.event_url,'request_id',r.request_id,
   'status',r.status,'fields',r.fields,'message',r.message) INTO result
 FROM individual_lottery_private.requests r WHERE r.event_url=p_url;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION individual_lottery_private.list_recent()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF (SELECT auth.uid()) IS DISTINCT FROM '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('url',r.event_url,
   'request_id',r.request_id,'status',r.status,'fields',r.fields,'message',r.message,
   'updated_at',r.updated_at) ORDER BY r.updated_at DESC),'[]'::jsonb) INTO result
 FROM (SELECT * FROM individual_lottery_private.requests
   WHERE updated_at>now()-interval '2 days' ORDER BY updated_at DESC LIMIT 100) r;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION individual_lottery_private.worker_peek()
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result integer;
BEGIN
 IF (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'service_role' THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 SELECT count(*)::integer INTO result FROM individual_lottery_private.requests
 WHERE status='pending' OR (status='running' AND updated_at<now()-interval '30 minutes');
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION individual_lottery_private.worker_claim()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item individual_lottery_private.requests%ROWTYPE;
BEGIN
 IF (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'service_role' THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 SELECT * INTO item FROM individual_lottery_private.requests
 WHERE status='pending' OR (status='running' AND updated_at<now()-interval '30 minutes')
 ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE individual_lottery_private.requests SET status='running',started_at=now(),updated_at=now()
 WHERE event_url=item.event_url;
 RETURN pg_catalog.jsonb_build_object('url',item.event_url,'request_id',item.request_id);
END $$;
CREATE OR REPLACE FUNCTION individual_lottery_private.worker_finish(p_id uuid,p_status text,p_fields jsonb,p_message text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed integer;
BEGIN
 IF (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'service_role' THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 IF p_status NOT IN ('success','blocked','unavailable','error') OR
    p_fields IS NULL OR jsonb_typeof(p_fields)<>'object' OR length(p_fields::text)>12000 OR
    p_message IS NULL OR length(p_message)>300 THEN
   RAISE EXCEPTION 'Invalid result' USING ERRCODE='22023';
 END IF;
 UPDATE individual_lottery_private.requests SET status=p_status,fields=p_fields,
   message=p_message,updated_at=now() WHERE request_id=p_id AND status='running';
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed=1;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA individual_lottery_private FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION individual_lottery_private.request_one(text),individual_lottery_private.list_recent() TO authenticated;
GRANT EXECUTE ON FUNCTION individual_lottery_private.worker_peek(),individual_lottery_private.worker_claim(),individual_lottery_private.worker_finish(uuid,text,jsonb,text) TO service_role;

CREATE OR REPLACE FUNCTION public.livepocket_individual_request_v1(p_url text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT individual_lottery_private.request_one(p_url) $$;
CREATE OR REPLACE FUNCTION public.livepocket_individual_list_v1()
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT individual_lottery_private.list_recent() $$;
CREATE OR REPLACE FUNCTION public.livepocket_individual_peek_v1()
RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT individual_lottery_private.worker_peek() $$;
CREATE OR REPLACE FUNCTION public.livepocket_individual_claim_v1()
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT individual_lottery_private.worker_claim() $$;
CREATE OR REPLACE FUNCTION public.livepocket_individual_finish_v1(p_id uuid,p_status text,p_fields jsonb,p_message text)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT individual_lottery_private.worker_finish(p_id,p_status,p_fields,p_message) $$;
REVOKE ALL ON FUNCTION public.livepocket_individual_request_v1(text),public.livepocket_individual_list_v1(),public.livepocket_individual_peek_v1(),public.livepocket_individual_claim_v1(),public.livepocket_individual_finish_v1(uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.livepocket_individual_request_v1(text),public.livepocket_individual_list_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.livepocket_individual_peek_v1(),public.livepocket_individual_claim_v1(),public.livepocket_individual_finish_v1(uuid,text,jsonb,text) TO service_role;
