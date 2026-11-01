-- v21.161: Information Plaza shared sales-format editor
-- Signed-in users can read, add, edit, and delete a store's sales format and notes.
-- Guest users remain blocked. Master suggestions are exposed through a safe RPC.
BEGIN;

ALTER TABLE public.info_plaza_store_sales ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS info_plaza_sales_dev_select ON public.info_plaza_store_sales;
DROP POLICY IF EXISTS info_plaza_sales_dev_insert ON public.info_plaza_store_sales;
DROP POLICY IF EXISTS info_plaza_sales_dev_update ON public.info_plaza_store_sales;
DROP POLICY IF EXISTS info_plaza_sales_dev_delete ON public.info_plaza_store_sales;
DROP POLICY IF EXISTS info_plaza_sales_member_select ON public.info_plaza_store_sales;
DROP POLICY IF EXISTS info_plaza_sales_member_insert ON public.info_plaza_store_sales;
DROP POLICY IF EXISTS info_plaza_sales_member_update ON public.info_plaza_store_sales;
DROP POLICY IF EXISTS info_plaza_sales_member_delete ON public.info_plaza_store_sales;

CREATE POLICY info_plaza_sales_member_select ON public.info_plaza_store_sales
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) IS NOT NULL);
CREATE POLICY info_plaza_sales_member_insert ON public.info_plaza_store_sales
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND updated_by=(SELECT auth.uid()));
CREATE POLICY info_plaza_sales_member_update ON public.info_plaza_store_sales
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL)
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND updated_by=(SELECT auth.uid()));
CREATE POLICY info_plaza_sales_member_delete ON public.info_plaza_store_sales
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) IS NOT NULL);

-- Expose required editor columns, not the internal editor UUID.
REVOKE ALL PRIVILEGES ON TABLE public.info_plaza_store_sales FROM PUBLIC,anon,authenticated;
GRANT SELECT (id,store_name,store_key,prefecture,genre,shrink_state,
              peri_state,tape_cut_state,notes,updated_at)
  ON TABLE public.info_plaza_store_sales TO authenticated;
GRANT INSERT (store_name,store_key,prefecture,genre,shrink_state,
              peri_state,tape_cut_state,notes,updated_by,updated_at)
  ON TABLE public.info_plaza_store_sales TO authenticated;
GRANT UPDATE (store_name,store_key,prefecture,genre,shrink_state,
              peri_state,tape_cut_state,notes,updated_by,updated_at)
  ON TABLE public.info_plaza_store_sales TO authenticated;
GRANT DELETE ON TABLE public.info_plaza_store_sales TO authenticated;

CREATE OR REPLACE FUNCTION public.lottery_store_master_choices_v1()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $function$
DECLARE result jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL
     OR (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Login required' USING ERRCODE='42501';
  END IF;
  SELECT pg_catalog.jsonb_build_object('masters',
    COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('name',m.store_name,'prefecture',m.prefecture)
      ORDER BY m.prefecture,m.store_name
    ), '[]'::jsonb))
    INTO result
  FROM (
    SELECT store_name,prefecture FROM private.lottery_store_master_v1
    WHERE merged_into IS NULL AND store_name IS NOT NULL AND prefecture IS NOT NULL
    ORDER BY prefecture,store_name LIMIT 5000
  ) m;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.lottery_store_master_choices_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_store_master_choices_v1() TO authenticated;

CREATE OR REPLACE FUNCTION public.lottery_store_sales_reference_v1()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $function$
DECLARE result jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL
     OR (SELECT auth.jwt()->>'role') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Login required' USING ERRCODE='42501';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'store_name',s.store_name,'store_key',s.store_key,
      'prefecture',s.prefecture,'genre',s.genre,
      'shrink_state',s.shrink_state,'peri_state',s.peri_state,
      'tape_cut_state',s.tape_cut_state,'notes',s.notes,
      'updated_at',s.updated_at
    ) ORDER BY s.store_key,s.prefecture,s.genre
  ),'[]'::jsonb) INTO result
  FROM (
    SELECT store_name,store_key,prefecture,genre,
           shrink_state,peri_state,tape_cut_state,notes,updated_at
    FROM public.info_plaza_store_sales
    WHERE (genre='pokemon' AND
             (shrink_state<>'unknown' OR peri_state<>'unknown'))
       OR (genre='onepiece' AND tape_cut_state<>'unknown')
       OR btrim(notes)<>''
    ORDER BY store_key,prefecture,genre LIMIT 5000
  ) s;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.lottery_store_sales_reference_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_store_sales_reference_v1() TO authenticated;

COMMIT;
