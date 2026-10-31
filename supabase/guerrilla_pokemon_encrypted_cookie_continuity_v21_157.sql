-- v21.157: Short-lived encrypted Cookie continuity for the monitor's OWN
-- retailer session, never for user/safari cookies or queue bypass.
-- Public state is RLS-protected (no direct client policies); the ciphertext
-- cannot be decrypted without the server-side NOTIFY_SECRET.
ALTER TABLE public.guerrilla_fast_state
  ADD COLUMN IF NOT EXISTS session_cookie_ciphertext text,
  ADD COLUMN IF NOT EXISTS session_cookie_expires_at timestamptz;
ALTER TABLE public.guerrilla_fast_state
  DROP CONSTRAINT IF EXISTS guerrilla_fast_cookie_ciphertext_bounded_v1;
ALTER TABLE public.guerrilla_fast_state
  ADD CONSTRAINT guerrilla_fast_cookie_ciphertext_bounded_v1
    CHECK (session_cookie_ciphertext IS NULL
           OR length(session_cookie_ciphertext) BETWEEN 20 AND 24000);
COMMENT ON COLUMN public.guerrilla_fast_state.session_cookie_ciphertext IS
 'Encrypted first-party bot session cookies, short-lived; never exposed in RPCs or logs';
COMMENT ON COLUMN public.guerrilla_fast_state.session_cookie_expires_at IS
 'Maximum life of encrypted first-party bot cookie jar';