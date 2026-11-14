-- Wishlist state is independent of owned quantity and uses the existing
-- per-account RLS. Existing quantity-only clients continue to work.
ALTER TABLE public.pokemon_card_collection_v1
  ADD COLUMN wanted boolean NOT NULL DEFAULT false;
GRANT UPDATE (wanted) ON public.pokemon_card_collection_v1 TO authenticated;

CREATE FUNCTION public.pokemon_card_wanted_set_v1(p_card_id integer, p_wanted boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  actor uuid := (SELECT auth.uid());
  saved boolean;
BEGIN
  IF NOT public.pokemon_card_access_v1() THEN
    RAISE EXCEPTION 'Verified Discord login required' USING ERRCODE = '42501';
  END IF;
  IF p_card_id IS NULL OR p_card_id <= 0 OR p_wanted IS NULL THEN
    RAISE EXCEPTION 'Invalid card or wanted value' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.pokemon_card_collection_v1 AS owned (user_id, card_id, quantity, wanted)
    VALUES (actor, p_card_id, 0, p_wanted)
    ON CONFLICT (user_id, card_id) DO UPDATE SET wanted = excluded.wanted
    RETURNING wanted INTO saved;
  RETURN saved;
END;
$$;
REVOKE ALL ON FUNCTION public.pokemon_card_wanted_set_v1(integer,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pokemon_card_wanted_set_v1(integer,boolean) TO authenticated;

CREATE FUNCTION public.pokemon_card_set_search_v2(p_group_id integer)
RETURNS TABLE (card_id integer, name text, set_code text, card_number text,
  sort_order integer, quantity integer, official_image_path text, wanted boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT card.card_id, card.name, card.set_code, card.card_number, entry.sort_order,
    coalesce(owned.quantity, 0), card.official_image_path, coalesce(owned.wanted, false)
  FROM public.pokemon_card_set_entries_v1 AS entry
  JOIN public.pokemon_cards_v1 AS card ON card.card_id = entry.card_id
  LEFT JOIN public.pokemon_card_collection_v1 AS owned
    ON owned.card_id = card.card_id AND owned.user_id = (SELECT auth.uid())
  WHERE entry.official_group_id = p_group_id
  ORDER BY entry.sort_order, card.card_id;
$$;
REVOKE ALL ON FUNCTION public.pokemon_card_set_search_v2(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pokemon_card_set_search_v2(integer) TO authenticated;
