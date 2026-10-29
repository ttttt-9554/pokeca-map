-- v21.121: also master externally verified stores; allow correcting a wrong merge.
DROP TRIGGER IF EXISTS lottery_store_sync_external_event_v1
 ON public.lottery_external_event_overrides;
CREATE TRIGGER lottery_store_sync_external_event_v1
AFTER INSERT OR UPDATE OF store_name,prefecture ON public.lottery_external_event_overrides
FOR EACH ROW EXECUTE FUNCTION private.lottery_store_event_sync_v1();
SELECT private.lottery_store_add_v1(store_name,prefecture)
FROM public.lottery_external_event_overrides WHERE state='active';

CREATE OR REPLACE FUNCTION public.lottery_store_unmerge_v1(p_source uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE affected integer;
BEGIN
 IF (SELECT auth.uid()) IS DISTINCT FROM
  '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid
 THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 UPDATE private.lottery_store_master_v1 SET merged_into=null,updated_at=now()
 WHERE id=p_source AND merged_into IS NOT NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN affected=1;
END;
$$;
REVOKE ALL ON FUNCTION public.lottery_store_unmerge_v1(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.lottery_store_unmerge_v1(uuid) TO authenticated;
