-- Short-lived URL previews for role-authorized app users.
BEGIN;
CREATE TABLE IF NOT EXISTS public.lottery_discord_intake_v1 (
  url text PRIMARY KEY CHECK (octet_length(url) BETWEEN 12 AND 2000
    AND url ~ '^https?://' AND url !~ '[[:space:][:cntrl:]]'),
  discord_posted_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.lottery_discord_intake_v1 ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS lottery_discord_intake_posted_idx
  ON public.lottery_discord_intake_v1 (discord_posted_at DESC);
REVOKE ALL ON public.lottery_discord_intake_v1 FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.lottery_discord_intake_v1 TO authenticated;
GRANT SELECT, INSERT ON public.lottery_discord_intake_v1 TO service_role;

DO $policy$
BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
  AND tablename='lottery_discord_intake_v1' AND policyname='lottery_discord_intake_read') THEN
CREATE POLICY lottery_discord_intake_read ON public.lottery_discord_intake_v1
FOR SELECT TO authenticated USING (
  discord_posted_at > now() - interval '2 hours' AND
  (SELECT auth.uid()) IS NOT NULL AND (
    CASE WHEN ((SELECT auth.jwt())->>'toreca_discord_role_until') ~ '^[0-9]{1,12}$'
      THEN ((SELECT auth.jwt())->>'toreca_discord_role_until')::bigint > extract(epoch FROM now())
      ELSE false
    END OR (SELECT public.discord_role_allowed_v1())
  )
);
END IF;
END;
$policy$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime'
    AND schemaname='public' AND tablename='lottery_discord_intake_v1') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lottery_discord_intake_v1;
  END IF;
END;
$$;
COMMIT;
