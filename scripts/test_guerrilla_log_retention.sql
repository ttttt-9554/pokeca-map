-- Isolated database only. net.http_post records a fake call and never sends it.
BEGIN;
CREATE SCHEMA private;
CREATE SCHEMA cron;
CREATE SCHEMA net;
CREATE SCHEMA vault;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobname text UNIQUE,schedule text,command text,username text DEFAULT current_user,active boolean DEFAULT true);
CREATE TABLE cron.job_run_details(runid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobid bigint,username text DEFAULT current_user,status text,start_time timestamptz,end_time timestamptz);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3)
  ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command RETURNING jobid;
$$;
CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,
  database text DEFAULT NULL,username text DEFAULT NULL,active boolean DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job SET schedule=coalesce($2,schedule),command=coalesce($3,command),
    username=coalesce($5,username),active=coalesce($6,active) WHERE jobid=$1;
$$;
CREATE TABLE public.guerrilla_push_subscriptions(id text PRIMARY KEY,enabled boolean);
CREATE TABLE public.guerrilla_sale_push_queue(event_id text,subscription_id text,status text,
  available_at timestamptz DEFAULT now(),locked_until timestamptz);
CREATE TABLE public.guerrilla_sale_events(id text);
INSERT INTO public.guerrilla_sale_events VALUES('preserved-sale-event');
CREATE TABLE net.fake_calls(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,url text,headers jsonb,body jsonb);
CREATE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb,timeout_milliseconds integer DEFAULT 2000)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net.fake_calls(url,headers,body) VALUES($1,$4,$2) RETURNING id;
$$;
CREATE TABLE vault.decrypted_secrets(name text,decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES('discord_notification_dispatch_key','dummy-test-value');
SELECT cron.schedule('guerrilla_fast_monitor_v1','* * * * *','preserve-monitor-command');
SELECT cron.schedule('guerrilla_sale_push_drain_v1','* * * * *','old-push-command');
SELECT cron.schedule('unrelated_notifications','*/5 * * * *','preserve-other-command');
UPDATE cron.job SET active=false WHERE jobname='guerrilla_sale_push_drain_v1';

\ir ../supabase/guerrilla_run_log_compaction_v1.sql
-- Reapplying must not create duplicate jobs or turn a paused sender back on.
\ir ../supabase/guerrilla_run_log_compaction_v1.sql

DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job)<>4 THEN RAISE EXCEPTION 'Duplicate scheduler'; END IF;
  IF (SELECT command FROM cron.job WHERE jobname='guerrilla_fast_monitor_v1')<>'preserve-monitor-command'
    THEN RAISE EXCEPTION 'Monitor altered'; END IF;
  IF (SELECT active OR schedule<>'* * * * *' FROM cron.job WHERE jobname='guerrilla_sale_push_drain_v1')
    THEN RAISE EXCEPTION 'Push ON/OFF state or interval changed'; END IF;
END;
$$;

WITH base AS (SELECT (date_trunc('day',now() AT TIME ZONE 'Asia/Tokyo')-interval '3 days')
  AT TIME ZONE 'Asia/Tokyo' AS t), records(job_name,status,first_at,last_at) AS (
  SELECT 'guerrilla_fast_monitor_v1','succeeded',t+interval '1 hour',t+interval '1 hour 1 second' FROM base UNION ALL
  SELECT 'guerrilla_fast_monitor_v1','succeeded',t+interval '23 hours 59 minutes',t+interval '23 hours 59 minutes 1 second' FROM base UNION ALL
  SELECT 'guerrilla_fast_monitor_v1','succeeded',t+interval '24 hours 1 minute',t+interval '24 hours 1 minute 1 second' FROM base UNION ALL
  SELECT 'guerrilla_sale_push_drain_v1','succeeded',t+interval '4 hours',t+interval '4 hours 1 second' FROM base UNION ALL
  SELECT 'guerrilla_run_log_compaction_v1','succeeded',t+interval '5 hours',t+interval '5 hours 1 second' FROM base UNION ALL
  SELECT 'guerrilla_fast_monitor_v1','succeeded',now()-interval '1 hour',now()-interval '59 minutes' UNION ALL
  SELECT 'guerrilla_fast_monitor_v1','failed',t+interval '6 hours',t+interval '6 hours 1 second' FROM base UNION ALL
  SELECT 'guerrilla_fast_monitor_v1','running',t+interval '7 hours',NULL FROM base UNION ALL
  SELECT 'guerrilla_fast_monitor_v1','succeeded',t+interval '8 hours',t+interval '7 hours' FROM base UNION ALL
  SELECT 'unrelated_notifications','succeeded',t,t+interval '1 second' FROM base
)
INSERT INTO cron.job_run_details(jobid,status,start_time,end_time)
SELECT j.jobid,r.status,r.first_at,r.last_at FROM records r JOIN cron.job j ON j.jobname=r.job_name;
DO $$
DECLARE result jsonb;
BEGIN
  result:=private.guerrilla_compact_run_logs_v1();
  IF (result->>'compacted')::int<>5 THEN RAISE EXCEPTION 'Unexpected compaction: %',result; END IF;
  IF (SELECT count(*) FROM cron.job_run_details)<>5 THEN RAISE EXCEPTION 'Deleted protected records'; END IF;
  IF (SELECT sum(total_runs) FROM private.guerrilla_run_log_daily_v1)<>5 THEN RAISE EXCEPTION 'Lost daily count'; END IF;
  IF (SELECT sum(total_duration_ms) FROM private.guerrilla_run_log_daily_v1)<>5000 THEN RAISE EXCEPTION 'Lost duration'; END IF;
  IF (SELECT count(*) FROM private.guerrilla_run_log_daily_v1 WHERE job_name='guerrilla_fast_monitor_v1')<>2
    THEN RAISE EXCEPTION 'Japan midnight grouping failed'; END IF;
  IF (SELECT min(run_day) FROM private.guerrilla_run_log_daily_v1)<>
      (now() AT TIME ZONE 'Asia/Tokyo')::date-3 THEN RAISE EXCEPTION 'Wrong local day'; END IF;
  result:=private.guerrilla_compact_run_logs_v1();
  IF (result->>'compacted')::int<>0 THEN RAISE EXCEPTION 'Double counted an old run'; END IF;
  IF (SELECT count(*) FROM public.guerrilla_sale_events)<>1 THEN RAISE EXCEPTION 'Sale event altered'; END IF;
END;
$$;
INSERT INTO cron.job_run_details(jobid,status,start_time,end_time)
SELECT jobid,'succeeded',now()-interval '3 days',now()-interval '3 days'+interval '2 seconds'
FROM cron.job WHERE jobname='guerrilla_fast_monitor_v1';
SELECT private.guerrilla_compact_run_logs_v1();
DO $$ BEGIN
  IF (SELECT sum(total_runs) FROM private.guerrilla_run_log_daily_v1)<>6 OR
     (SELECT sum(total_duration_ms) FROM private.guerrilla_run_log_daily_v1)<>7000
  THEN RAISE EXCEPTION 'Incremental summary lost data'; END IF;
END; $$;

-- A failed summary write must roll back the associated deletion.
INSERT INTO cron.job_run_details(jobid,status,start_time,end_time)
SELECT jobid,'succeeded',now()-interval '4 days',now()-interval '4 days'+interval '1 second'
FROM cron.job WHERE jobname='guerrilla_fast_monitor_v1';
CREATE FUNCTION private.reject_test_summary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'forced archive failure' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER reject_test_summary BEFORE INSERT ON private.guerrilla_run_log_daily_v1
FOR EACH ROW EXECUTE FUNCTION private.reject_test_summary();
DO $$ BEGIN
  BEGIN
    PERFORM private.guerrilla_compact_run_logs_v1();
    RAISE EXCEPTION 'Expected archive failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM cron.job_run_details)<>6 OR
     (SELECT sum(total_runs) FROM private.guerrilla_run_log_daily_v1)<>6
  THEN RAISE EXCEPTION 'Archive failure lost raw history'; END IF;
END; $$;
DROP TRIGGER reject_test_summary ON private.guerrilla_run_log_daily_v1;
SELECT private.guerrilla_compact_run_logs_v1();

-- No work, future retries, active leases and disabled subscribers stay idle.
SELECT private.guerrilla_sale_push_if_due_v1();
INSERT INTO public.guerrilla_push_subscriptions VALUES('enabled',true),('disabled',false);
INSERT INTO public.guerrilla_sale_push_queue VALUES
  ('future','enabled','retry',now()+interval '1 hour',NULL),
  ('leased','enabled','sending',now()-interval '1 hour',now()+interval '1 hour'),
  ('disabled','disabled','pending',now()-interval '1 hour',NULL),
  ('sent','enabled','sent',now()-interval '1 hour',NULL);
SELECT private.guerrilla_sale_push_if_due_v1();
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM net.fake_calls) THEN RAISE EXCEPTION 'Idle or ineligible queue invoked sender'; END IF;
END; $$;
INSERT INTO public.guerrilla_sale_push_queue VALUES('pending','enabled','pending',now()-interval '1 minute',NULL);
SELECT private.guerrilla_sale_push_if_due_v1();
DELETE FROM public.guerrilla_sale_push_queue WHERE event_id='pending';
INSERT INTO public.guerrilla_sale_push_queue VALUES('retry','enabled','retry',now()-interval '1 minute',NULL);
SELECT private.guerrilla_sale_push_if_due_v1();
DELETE FROM public.guerrilla_sale_push_queue WHERE event_id='retry';
INSERT INTO public.guerrilla_sale_push_queue VALUES('expired','enabled','sending',now()-interval '1 hour',now()-interval '1 minute');
SELECT private.guerrilla_sale_push_if_due_v1();
DO $$ BEGIN
  IF (SELECT count(*) FROM net.fake_calls)<>3 THEN RAISE EXCEPTION 'Lost pending/retry/lease recovery'; END IF;
  IF EXISTS(SELECT 1 FROM net.fake_calls WHERE body<>'{"type":"DRAIN"}'::jsonb OR
    url<>'https://aypcmtlaaygmiexboypk.supabase.co/functions/v1/guerrilla-push')
    THEN RAISE EXCEPTION 'Wrong dispatch path'; END IF;
  IF has_function_privilege('anon','private.guerrilla_compact_run_logs_v1()','execute') OR
     has_function_privilege('authenticated','private.guerrilla_sale_push_if_due_v1()','execute') OR
     has_function_privilege('service_role','private.guerrilla_compact_run_logs_v1()','execute') OR
     has_table_privilege('anon','private.guerrilla_run_log_daily_v1','select')
    THEN RAISE EXCEPTION 'Maintenance was exposed'; END IF;
END; $$;
SELECT 'passed: scoped retention, Japan days, incremental counts, atomic rollback, idle suppression, retry recovery and permissions' AS result;
ROLLBACK;
