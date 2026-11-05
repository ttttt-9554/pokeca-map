-- A short-lived, one-use routing marker lets the existing authenticated
-- GitHub dispatcher start exactly one requested event without a bulk sweep.
ALTER TABLE individual_lottery_private.requests
  ADD COLUMN IF NOT EXISTS dispatch_requested_at timestamptz;

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
   fields='{}'::jsonb,message='',requested_at=now(),updated_at=now(),started_at=NULL,dispatch_requested_at=NULL
 WHERE individual_lottery_private.requests.status NOT IN ('pending','running')
    OR individual_lottery_private.requests.updated_at < now()-interval '30 minutes';
 SELECT pg_catalog.jsonb_build_object('url',r.event_url,'request_id',r.request_id,
   'status',r.status,'fields',r.fields,'message',r.message) INTO result
 FROM individual_lottery_private.requests r WHERE r.event_url=p_url;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION individual_lottery_private.mark_dispatch(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed integer;
BEGIN
 IF (SELECT auth.uid()) IS DISTINCT FROM '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 UPDATE individual_lottery_private.requests SET dispatch_requested_at=now()
 WHERE request_id=p_id AND status='pending';
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed=1;
END $$;
CREATE OR REPLACE FUNCTION individual_lottery_private.take_dispatch()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item individual_lottery_private.requests%ROWTYPE;
BEGIN
 IF (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'service_role' THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 SELECT * INTO item FROM individual_lottery_private.requests
 WHERE dispatch_requested_at IS NOT NULL AND dispatch_requested_at>now()-interval '30 minutes'
 ORDER BY dispatch_requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE individual_lottery_private.requests SET dispatch_requested_at=NULL WHERE event_url=item.event_url;
 RETURN pg_catalog.jsonb_build_object('request_id',item.request_id);
END $$;
CREATE OR REPLACE FUNCTION individual_lottery_private.worker_claim_one(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item individual_lottery_private.requests%ROWTYPE;
BEGIN
 IF (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'service_role' THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 UPDATE individual_lottery_private.requests SET status='running',started_at=now(),updated_at=now()
 WHERE request_id=p_id AND (status='pending' OR (status='running' AND updated_at<now()-interval '30 minutes'))
 RETURNING * INTO item;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN pg_catalog.jsonb_build_object('url',item.event_url,'request_id',item.request_id);
END $$;
REVOKE ALL ON FUNCTION individual_lottery_private.mark_dispatch(uuid),individual_lottery_private.take_dispatch(),individual_lottery_private.worker_claim_one(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION individual_lottery_private.mark_dispatch(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION individual_lottery_private.take_dispatch(),individual_lottery_private.worker_claim_one(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.livepocket_individual_mark_dispatch_v1(p_id uuid)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT individual_lottery_private.mark_dispatch(p_id) $$;
CREATE OR REPLACE FUNCTION public.livepocket_individual_take_dispatch_v1()
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT individual_lottery_private.take_dispatch() $$;
CREATE OR REPLACE FUNCTION public.livepocket_individual_claim_one_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT individual_lottery_private.worker_claim_one(p_id) $$;
REVOKE ALL ON FUNCTION public.livepocket_individual_mark_dispatch_v1(uuid),public.livepocket_individual_take_dispatch_v1(),public.livepocket_individual_claim_one_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.livepocket_individual_mark_dispatch_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.livepocket_individual_take_dispatch_v1(),public.livepocket_individual_claim_one_v1(uuid) TO service_role;
