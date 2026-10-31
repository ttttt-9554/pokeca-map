-- v21.158: Remove unused session-cookie storage fields.
-- Diagnose only non-sensitive cookie attributes, with no session token storage.
ALTER TABLE public.guerrilla_fast_state
 DROP CONSTRAINT IF EXISTS guerrilla_fast_cookie_ciphertext_bounded_v1;
ALTER TABLE public.guerrilla_fast_state
 DROP COLUMN IF EXISTS session_cookie_ciphertext,
 DROP COLUMN IF EXISTS session_cookie_expires_at;