-- Developer-only Supabase usage gauges, no secrets or private row contents.
-- Free reference quotas are guidance, not billed monthly usage.
CREATE OR REPLACE FUNCTION public.toreca_developer_usage_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  result jsonb;
BEGIN
  IF (SELECT auth.uid()) IS DISTINCT FROM
      '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid
     OR (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'authenticated'
  THEN
    RAISE EXCEPTION 'Developer access required' USING ERRCODE='42501';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'schema_version',1,
    'observed_at',pg_catalog.clock_timestamp(),
    'database_bytes',pg_catalog.pg_database_size(pg_catalog.current_database()),
    'database_free_reference_bytes',500000000,
    'storage_bytes',coalesce((
      SELECT pg_catalog.sum(
        CASE WHEN coalesce(o.metadata->>'size','') ~ '^[0-9]{1,18}$'
          THEN (o.metadata->>'size')::bigint ELSE 0::bigint END
      ) FROM storage.objects o
    ),0),
    'storage_free_reference_bytes',1000000000,
    'storage_objects',(SELECT pg_catalog.count(*) FROM storage.objects),
    'storage_buckets',(SELECT pg_catalog.count(*) FROM storage.buckets),
    'auth_users',(SELECT pg_catalog.count(*) FROM auth.users),
    'auth_signed_in_30d',(SELECT pg_catalog.count(*) FROM auth.users
       WHERE last_sign_in_at>=pg_catalog.now()-interval '30 days'),
    'connections',(SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity
       WHERE datname=pg_catalog.current_database()),
    'max_connections',pg_catalog.current_setting('max_connections')::integer,
    'cron_jobs',(SELECT pg_catalog.count(*) FROM cron.job),
    'cron_active',(SELECT pg_catalog.count(*) FROM cron.job WHERE active),
    'cron_runs_24h',(SELECT pg_catalog.count(*) FROM cron.job_run_details
       WHERE start_time>=pg_catalog.now()-interval '24 hours'),
    'cron_failed_24h',(SELECT pg_catalog.count(*) FROM cron.job_run_details
       WHERE start_time>=pg_catalog.now()-interval '24 hours' AND status='failed'),
    'top_tables',coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name',t.schema_name||'.'||t.table_name,
        'bytes',t.bytes,
        'approx_rows',t.approx_rows
      ) ORDER BY t.bytes DESC,t.schema_name,t.table_name)
      FROM (
        SELECT n.nspname::text AS schema_name,c.relname::text AS table_name,
          pg_catalog.pg_total_relation_size(c.oid) AS bytes,
          CASE WHEN c.reltuples>=0 THEN c.reltuples::bigint ELSE NULL END AS approx_rows
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','private') AND c.relkind='r'
        ORDER BY pg_catalog.pg_total_relation_size(c.oid) DESC,n.nspname,c.relname
        LIMIT 8
      ) t
    ),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.toreca_developer_usage_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.toreca_developer_usage_v1() TO authenticated;
