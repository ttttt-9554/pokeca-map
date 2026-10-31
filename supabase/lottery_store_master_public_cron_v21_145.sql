-- v21.145: Keep the private store master in sync with published lottery cards.
-- Uses the existing secured Vault dispatch secret; does not touch Discord.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job
    WHERE jobname='lottery_store_master_public_catalog_v21_145') THEN
    PERFORM cron.schedule(
      'lottery_store_master_public_catalog_v21_145',
      '*/15 * * * *',
      $job$
        SELECT net.http_post(
          url:='https://aypcmtlaaygmiexboypk.supabase.co/functions/v1/lottery-store-sync',
          headers:=jsonb_build_object(
            'Content-Type','application/json',
            'x-notify-secret',
            (SELECT decrypted_secret FROM vault.decrypted_secrets
             WHERE name='discord_notification_dispatch_key')
          ),
          body:='{"type":"SYNC"}'::jsonb,
          timeout_milliseconds:=40000
        );
      $job$
    );
  END IF;
END;
$$;