-- Preserve minute-by-minute monitoring. Compact only routine Cron history;
-- sale events, product baselines, delivery queues and failures stay intact.
CREATE TABLE IF NOT EXISTS private.guerrilla_run_log_daily_v1 (
  job_name text NOT NULL CHECK(job_name IN ('guerrilla_fast_monitor_v1',
    'guerrilla_sale_push_drain_v1','guerrilla_run_log_compaction_v1')),
  run_day date NOT NULL,
  total_runs bigint NOT NULL CHECK(total_runs>0),
  first_started_at timestamptz NOT NULL,
  last_finished_at timestamptz NOT NULL,
  total_duration_ms numeric NOT NULL CHECK(total_duration_ms>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_name,run_day)
);
ALTER TABLE private.guerrilla_run_log_daily_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.guerrilla_run_log_daily_v1 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.guerrilla_compact_run_logs_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE compacted bigint; daily_rows bigint;
BEGIN
  -- Prevent two cleanup calls from counting the same batch concurrently.
  LOCK TABLE private.guerrilla_run_log_daily_v1 IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  WITH removed AS (
    DELETE FROM cron.job_run_details d USING cron.job j
    WHERE d.jobid=j.jobid AND j.username=current_user AND d.username=current_user
      AND j.jobname IN ('guerrilla_fast_monitor_v1','guerrilla_sale_push_drain_v1',
        'guerrilla_run_log_compaction_v1')
      AND d.status='succeeded' AND d.start_time IS NOT NULL
      AND d.end_time>=d.start_time AND d.end_time<now()-interval '24 hours'
    RETURNING j.jobname,d.start_time,d.end_time
  ), grouped AS (
    SELECT jobname,(start_time AT TIME ZONE 'Asia/Tokyo')::date AS run_day,
      count(*) AS total_runs,min(start_time) AS first_started_at,
      max(end_time) AS last_finished_at,
      sum(extract(epoch FROM end_time-start_time)*1000) AS total_duration_ms
    FROM removed GROUP BY jobname,(start_time AT TIME ZONE 'Asia/Tokyo')::date
  ), saved AS (
    INSERT INTO private.guerrilla_run_log_daily_v1 AS summary
      (job_name,run_day,total_runs,first_started_at,last_finished_at,total_duration_ms)
    SELECT jobname,run_day,total_runs,first_started_at,last_finished_at,total_duration_ms FROM grouped
    ON CONFLICT(job_name,run_day) DO UPDATE SET
      total_runs=summary.total_runs+excluded.total_runs,
      first_started_at=least(summary.first_started_at,excluded.first_started_at),
      last_finished_at=greatest(summary.last_finished_at,excluded.last_finished_at),
      total_duration_ms=summary.total_duration_ms+excluded.total_duration_ms,
      updated_at=clock_timestamp()
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM removed),(SELECT count(*) FROM saved) INTO compacted,daily_rows;
  RETURN jsonb_build_object('compacted',compacted,'updated_daily_rows',daily_rows,'raw_retention_hours',24);
EXCEPTION WHEN lock_not_available THEN
  RETURN jsonb_build_object('skipped',true,'reason','cleanup_running');
END;
$$;
REVOKE ALL ON FUNCTION private.guerrilla_compact_run_logs_v1() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.guerrilla_sale_push_if_due_v1()
RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  -- Match the existing push-claim eligibility, including expired worker leases.
  -- With no deliverable rows, do not invoke an Edge Function or read secrets.
  IF NOT EXISTS (
    SELECT 1 FROM public.guerrilla_sale_push_queue q
    JOIN public.guerrilla_push_subscriptions s ON s.id=q.subscription_id AND s.enabled
    WHERE (q.status IN ('pending','retry') AND q.available_at<=now())
      OR (q.status='sending' AND q.locked_until<now())
  ) THEN RETURN NULL; END IF;
  RETURN net.http_post(
    url:='https://aypcmtlaaygmiexboypk.supabase.co/functions/v1/guerrilla-push',
    headers:=jsonb_build_object('Content-Type','application/json','x-notify-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='discord_notification_dispatch_key')),
    body:='{"type":"DRAIN"}'::jsonb,timeout_milliseconds:=60000);
END;
$$;
REVOKE ALL ON FUNCTION private.guerrilla_sale_push_if_due_v1() FROM PUBLIC,anon,authenticated,service_role;

DO $$
DECLARE push_job bigint;
BEGIN
  SELECT jobid INTO push_job FROM cron.job
    WHERE jobname='guerrilla_sale_push_drain_v1' AND username=current_user;
  IF push_job IS NULL THEN RAISE EXCEPTION 'Existing push scheduler not found'; END IF;
  -- Only replace its command. Preserve the existing interval and ON/OFF state.
  PERFORM cron.alter_job(job_id:=push_job,command:='select private.guerrilla_sale_push_if_due_v1();');
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='guerrilla_run_log_compaction_v1' AND username=current_user) THEN
    PERFORM cron.schedule('guerrilla_run_log_compaction_v1','17 * * * *',
      'select private.guerrilla_compact_run_logs_v1();');
  END IF;
END;
$$;
