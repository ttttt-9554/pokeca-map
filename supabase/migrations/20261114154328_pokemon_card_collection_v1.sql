-- Card printings are identified by the official page ID. Product links can
-- disappear after a master merge without affecting the catalog or ownership.
CREATE TABLE public.pokemon_card_sets_v1 (
  official_group_id integer PRIMARY KEY CHECK (official_group_id > 0),
  product_id uuid REFERENCES public.catalog_products(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200)
);
CREATE INDEX pokemon_card_sets_product_idx ON public.pokemon_card_sets_v1 (product_id);

CREATE TABLE public.pokemon_cards_v1 (
  card_id integer PRIMARY KEY CHECK (card_id > 0),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  set_code text CHECK (set_code ~ '^[A-Za-z0-9+/\-]{1,20}$'),
  card_number text CHECK (card_number ~ '^[0-9]{1,5}[A-Za-z]?/([0-9]{1,5}|[A-Za-z0-9-]{1,12}/P)$')
);

CREATE TABLE public.pokemon_card_set_entries_v1 (
  official_group_id integer NOT NULL REFERENCES public.pokemon_card_sets_v1(official_group_id) ON DELETE CASCADE,
  card_id integer NOT NULL REFERENCES public.pokemon_cards_v1(card_id) ON DELETE RESTRICT,
  sort_order integer NOT NULL CHECK (sort_order > 0),
  PRIMARY KEY (official_group_id, card_id)
);
CREATE INDEX pokemon_card_set_entries_position_idx
  ON public.pokemon_card_set_entries_v1 (official_group_id, sort_order, card_id);
CREATE INDEX pokemon_card_set_entries_card_idx ON public.pokemon_card_set_entries_v1 (card_id);

CREATE TABLE public.pokemon_card_collection_v1 (
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id integer NOT NULL REFERENCES public.pokemon_cards_v1(card_id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 0 AND 9999),
  PRIMARY KEY (user_id, card_id)
);
CREATE INDEX pokemon_card_collection_card_idx ON public.pokemon_card_collection_v1 (card_id);

ALTER TABLE public.pokemon_card_sets_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pokemon_cards_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pokemon_card_set_entries_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pokemon_card_collection_v1 ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.pokemon_card_sets_v1, public.pokemon_cards_v1,
  public.pokemon_card_set_entries_v1, public.pokemon_card_collection_v1
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.pokemon_card_sets_v1, public.pokemon_cards_v1,
  public.pokemon_card_set_entries_v1 TO authenticated;
GRANT SELECT, INSERT ON public.pokemon_card_collection_v1 TO authenticated;
GRANT UPDATE (quantity) ON public.pokemon_card_collection_v1 TO authenticated;

-- Use the application's signed role proof or its current verification cache.
CREATE FUNCTION public.pokemon_card_access_v1()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND coalesce((SELECT auth.jwt()->>'is_anonymous'), 'false') = 'false'
    AND (
      CASE WHEN (SELECT auth.jwt()->>'toreca_discord_role_until') ~ '^[0-9]{1,12}$'
        THEN (SELECT auth.jwt()->>'toreca_discord_role_until')::bigint > extract(epoch FROM now())
        ELSE false
      END OR (SELECT public.discord_role_allowed_v1())
    );
$$;
REVOKE ALL ON FUNCTION public.pokemon_card_access_v1() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pokemon_card_access_v1() TO authenticated;

CREATE POLICY pokemon_card_sets_read ON public.pokemon_card_sets_v1
  FOR SELECT TO authenticated USING ((SELECT public.pokemon_card_access_v1()));
CREATE POLICY pokemon_cards_read ON public.pokemon_cards_v1
  FOR SELECT TO authenticated USING ((SELECT public.pokemon_card_access_v1()));
CREATE POLICY pokemon_card_set_entries_read ON public.pokemon_card_set_entries_v1
  FOR SELECT TO authenticated USING ((SELECT public.pokemon_card_access_v1()));
CREATE POLICY pokemon_card_collection_read ON public.pokemon_card_collection_v1
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()) AND (SELECT public.pokemon_card_access_v1()));
CREATE POLICY pokemon_card_collection_insert ON public.pokemon_card_collection_v1
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()) AND (SELECT public.pokemon_card_access_v1()));
CREATE POLICY pokemon_card_collection_update ON public.pokemon_card_collection_v1
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.pokemon_card_access_v1()))
  WITH CHECK (user_id = (SELECT auth.uid()) AND (SELECT public.pokemon_card_access_v1()));

CREATE FUNCTION public.pokemon_card_set_list_v1(p_group_id integer)
RETURNS TABLE (card_id integer, name text, set_code text, card_number text, sort_order integer, quantity integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT card.card_id, card.name, card.set_code, card.card_number, entry.sort_order,
    coalesce(owned.quantity, 0)
  FROM public.pokemon_card_set_entries_v1 AS entry
  JOIN public.pokemon_cards_v1 AS card ON card.card_id = entry.card_id
  LEFT JOIN public.pokemon_card_collection_v1 AS owned
    ON owned.card_id = card.card_id AND owned.user_id = (SELECT auth.uid())
  WHERE entry.official_group_id = p_group_id
  ORDER BY entry.sort_order, card.card_id;
$$;
REVOKE ALL ON FUNCTION public.pokemon_card_set_list_v1(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pokemon_card_set_list_v1(integer) TO authenticated;

-- Apply increments to the current saved count so writes from two devices do
-- not overwrite one another. RLS also applies inside this invoker function.
CREATE FUNCTION public.pokemon_card_quantity_adjust_v1(p_card_id integer, p_delta integer)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  actor uuid := (SELECT auth.uid());
  saved integer;
BEGIN
  IF NOT public.pokemon_card_access_v1() THEN
    RAISE EXCEPTION 'Verified Discord login required' USING ERRCODE = '42501';
  END IF;
  IF p_card_id IS NULL OR p_card_id <= 0 OR p_delta IS NULL OR p_delta NOT IN (-1, 1) THEN
    RAISE EXCEPTION 'Invalid card or quantity adjustment' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.pokemon_card_collection_v1 AS owned (user_id, card_id, quantity)
    VALUES (actor, p_card_id, greatest(0, p_delta))
    ON CONFLICT (user_id, card_id) DO UPDATE
      SET quantity = least(9999, greatest(0, owned.quantity + p_delta))
    RETURNING quantity INTO saved;
  RETURN saved;
END;
$$;
REVOKE ALL ON FUNCTION public.pokemon_card_quantity_adjust_v1(integer,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pokemon_card_quantity_adjust_v1(integer,integer) TO authenticated;
