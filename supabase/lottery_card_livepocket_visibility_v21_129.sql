-- v21.129: reversible LivePocket list removal via developer-managed flag.
-- Original events, correction history, and individual application data are not deleted.
ALTER TABLE public.lottery_card_overrides
  ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
GRANT SELECT (is_hidden) ON public.lottery_card_overrides TO anon, authenticated;
GRANT INSERT (is_hidden), UPDATE (is_hidden)
  ON public.lottery_card_overrides TO authenticated;
