-- Watch the actually deployed app catalog once per minute. The existing
-- notifier immediately drains newly queued entries and retries remain on the
-- independent minute-by-minute queue job. Retain, but disable, the duplicate
-- legacy five-minute scanner so the same catalog is not polled twice.
DO $$
DECLARE primary_id bigint;
BEGIN
 SELECT jobid INTO primary_id FROM cron.job WHERE jobname='lottery_livepocket_scan_v21_77';
 IF primary_id IS NULL THEN RAISE EXCEPTION 'Lottery scan job is missing'; END IF;
 PERFORM cron.alter_job(job_id := primary_id, schedule := '* * * * *', active := true);
 PERFORM cron.alter_job(job_id := jobid, active := false)
 FROM cron.job WHERE jobname='discord_livepocket_new_scan_v21_77';
END $$;
