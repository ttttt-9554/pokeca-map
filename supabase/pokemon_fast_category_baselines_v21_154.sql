-- v21.154: Per-category verified catalog baselines (booster packs and decks).
-- Do not treat the first successful visit to a category as new sales.
ALTER TABLE public.guerrilla_fast_state
 ADD COLUMN IF NOT EXISTS category_baselines jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.guerrilla_fast_state
 DROP CONSTRAINT IF EXISTS guerrilla_fast_state_category_baselines_check;
ALTER TABLE public.guerrilla_fast_state
 ADD CONSTRAINT guerrilla_fast_state_category_baselines_check
 CHECK (jsonb_typeof(category_baselines)='object');