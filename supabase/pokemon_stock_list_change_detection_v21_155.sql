-- v21.155: Remember which products were present in the verified
-- "in stock" filtered catalogue on the last successful read. Presence
-- alone does not imply purchasability; official detail confirmation required.
ALTER TABLE public.guerrilla_fast_state
 ADD COLUMN IF NOT EXISTS category_candidates jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.guerrilla_fast_state
 DROP CONSTRAINT IF EXISTS guerrilla_fast_state_category_candidates_check;
ALTER TABLE public.guerrilla_fast_state
 ADD CONSTRAINT guerrilla_fast_state_category_candidates_check
 CHECK (jsonb_typeof(category_candidates)='object');