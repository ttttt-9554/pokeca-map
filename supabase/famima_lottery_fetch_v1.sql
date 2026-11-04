-- A narrowly scoped Tokyo-region fetch for the existing scheduled collector.
-- No credentials, arbitrary URLs, or responses from other jobs are exposed.
CREATE SCHEMA IF NOT EXISTS famima_lottery_private;
REVOKE ALL ON SCHEMA famima_lottery_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA famima_lottery_private TO service_role;

CREATE TABLE IF NOT EXISTS famima_lottery_private.requests (
  id bigint PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE famima_lottery_private.requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE famima_lottery_private.requests FROM PUBLIC, anon, authenticated, service_role;
-- No direct table access: requests are available only through checked functions.
CREATE POLICY famima_requests_no_direct_access ON famima_lottery_private.requests
  FOR SELECT TO service_role USING (false);

CREATE OR REPLACE FUNCTION famima_lottery_private.begin_fetch(item_code text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE request_id bigint;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF item_code IS NULL OR item_code !~ '^[0-9]{10,25}$' THEN
    RAISE EXCEPTION 'invalid item code' USING ERRCODE = '22023';
  END IF;
  DELETE FROM famima_lottery_private.requests WHERE created_at < pg_catalog.now() - interval '1 day';
  SELECT net.http_get(
    url := 'https://famima-online.family.co.jp/item?itemCode=' || item_code,
    timeout_milliseconds := 15000
  ) INTO request_id;
  INSERT INTO famima_lottery_private.requests(id) VALUES (request_id);
  RETURN request_id;
END;
$function$;

CREATE OR REPLACE FUNCTION famima_lottery_private.fetch_result(request_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE result jsonb;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  SELECT pg_catalog.jsonb_build_object('status_code', r.status_code, 'timed_out', r.timed_out,
    'error', r.error_msg, 'content', CASE WHEN pg_catalog.length(r.content) <= 2000000 THEN r.content ELSE NULL END)
  INTO result
  FROM famima_lottery_private.requests AS q JOIN net._http_response AS r ON r.id = q.id
  WHERE q.id = request_id AND q.created_at > pg_catalog.now() - interval '5 minutes';
  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION famima_lottery_private.begin_fetch(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION famima_lottery_private.fetch_result(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION famima_lottery_private.begin_fetch(text) TO service_role;
GRANT EXECUTE ON FUNCTION famima_lottery_private.fetch_result(bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.famima_lottery_begin_v1(item_code text)
RETURNS bigint LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $function$
  SELECT famima_lottery_private.begin_fetch(item_code);
$function$;
CREATE OR REPLACE FUNCTION public.famima_lottery_result_v1(request_id bigint)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $function$
  SELECT famima_lottery_private.fetch_result(request_id);
$function$;
REVOKE ALL ON FUNCTION public.famima_lottery_begin_v1(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.famima_lottery_result_v1(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.famima_lottery_begin_v1(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.famima_lottery_result_v1(bigint) TO service_role;
