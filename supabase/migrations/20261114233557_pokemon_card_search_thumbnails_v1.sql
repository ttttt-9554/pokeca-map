-- Keep only the official source reference. Existing collection records and
-- the v1 list function stay compatible with clients already open in a tab.
ALTER TABLE public.pokemon_cards_v1 ADD COLUMN official_image_path text
  CHECK (char_length(official_image_path) <= 300 AND official_image_path ~
    ('^/assets/images/card_images/(large|legend)/[A-Za-z0-9_-]+/0*' || card_id::text || '_[A-Za-z0-9_-]+[.]jpg$'));

CREATE FUNCTION public.pokemon_card_set_search_v1(p_group_id integer)
RETURNS TABLE (card_id integer, name text, set_code text, card_number text,
  sort_order integer, quantity integer, official_image_path text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT result.card_id, result.name, result.set_code, result.card_number,
    result.sort_order, result.quantity, card.official_image_path
  FROM public.pokemon_card_set_list_v1(p_group_id) AS result
  JOIN public.pokemon_cards_v1 AS card ON card.card_id = result.card_id
  ORDER BY result.sort_order, result.card_id;
$$;
REVOKE ALL ON FUNCTION public.pokemon_card_set_search_v1(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pokemon_card_set_search_v1(integer) TO authenticated;
