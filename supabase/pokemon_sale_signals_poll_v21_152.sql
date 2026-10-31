-- v21.152: Check the public, anonymized sales corroboration data every 2 minutes.
-- The Discord bot token is never shared with the Edge Function. The GitHub
-- collector publishes no author, channel, message text, or hashed identifiers.
DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM cron.job
    WHERE jobname='pokemon_sale_signals_poll_v21_152'
  ) THEN
    PERFORM cron.schedule(
      'pokemon_sale_signals_poll_v21_152',
      '*/2 * * * *',
      $job$
        SELECT net.http_post(
          url:='https://aypcmtlaaygmiexboypk.supabase.co/functions/v1/pokemon-sale-signals',
          headers:=jsonb_build_object(
            'Content-Type','application/json',
            'x-notify-secret',
            (SELECT decrypted_secret
             FROM vault.decrypted_secrets
             WHERE name='discord_notification_dispatch_key')
          ),
          body:='{"type":"CHECK"}'::jsonb,
          timeout_milliseconds:=25000
        );
      $job$
    );
  END IF;
END;
$$;
