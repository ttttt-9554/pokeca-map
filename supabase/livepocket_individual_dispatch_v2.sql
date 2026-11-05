-- Keep a consumed marker until the request is requeued. Repeated taps from
-- another tab must not cause a second dispatch to fall through to bulk work.
ALTER TABLE individual_lottery_private.requests
  ADD COLUMN IF NOT EXISTS dispatch_taken_at timestamptz;

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
   fields='{}'::jsonb,message='',requested_at=now(),updated_at=now(),started_at=NULL,
   dispatch_requested_at=NULL,dispatch_taken_at=NULL
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
 WHERE request_id=p_id AND status='pending' AND dispatch_requested_at IS NULL;
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
 WHERE dispatch_requested_at IS NOT NULL AND dispatch_taken_at IS NULL
   AND dispatch_requested_at>now()-interval '30 minutes'
 ORDER BY dispatch_requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE individual_lottery_private.requests SET dispatch_taken_at=now() WHERE event_url=item.event_url;
 RETURN pg_catalog.jsonb_build_object('request_id',item.request_id);
END $$;
