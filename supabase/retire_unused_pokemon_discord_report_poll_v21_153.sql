-- v21.153: Retire human-Discord-sale-report polling: no such reports exist
-- in the currently connected channels. The official inventory monitor remains
-- active. Preserve historical tables without creating false stock events.
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname='pokemon_sale_signals_poll_v21_152';