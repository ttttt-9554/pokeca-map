-- Activate after deploying the Discord intake worker and verifying a poll.
SELECT cron.schedule('lottery_discord_intake_v1', '* * * * *', $job$
  DELETE FROM public.lottery_discord_intake_v1
  WHERE extract(minute FROM now()) = 0
    AND discord_posted_at < now() - interval '2 hours';

  SELECT net.http_post(
    url := 'https://aypcmtlaaygmiexboypk.supabase.co/functions/v1/lottery-discord-intake',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                          WHERE name='discord_notification_dispatch_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  );
$job$);
