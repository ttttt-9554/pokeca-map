-- Developer-only automatic store-master review, safe merges and explicit separate decisions.
CREATE OR REPLACE FUNCTION public.lottery_store_admin_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF (SELECT auth.uid()) IS DISTINCT FROM
   '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid
 THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;

 SELECT pg_catalog.jsonb_build_object(
  'masters',coalesce((
   SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'id',m.id,'name',m.store_name,'prefecture',m.prefecture,
     'merged_into',m.merged_into,'created_at',m.created_at)
     ORDER BY m.prefecture,m.store_name)
   FROM private.lottery_store_master_v1 m
  ),'[]'::jsonb),
  'candidates',coalesce((
   SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'left_id',p.left_id,'right_id',p.right_id,
    'left_name',p.left_name,'right_name',p.right_name,
    'prefecture',p.prefecture,'similarity',p.score)
    ORDER BY p.score DESC)
   FROM (
    SELECT a.id left_id,b.id right_id,a.store_name left_name,
      b.store_name right_name,a.prefecture,
      round(extensions.similarity(a.norm_name,b.norm_name)::numeric,2) score
    FROM private.lottery_store_master_v1 a
    JOIN private.lottery_store_master_v1 b ON
      a.id<b.id AND a.prefecture=b.prefecture
      AND a.merged_into IS NULL AND b.merged_into IS NULL
    LEFT JOIN private.lottery_store_pair_review_v1 rev
      ON rev.left_id=a.id AND rev.right_id=b.id
    WHERE rev.left_id IS NULL AND
      (extensions.similarity(a.norm_name,b.norm_name)>=0.53
       OR (length(a.norm_name)>=5 AND length(b.norm_name)>=5 AND
        (a.norm_name LIKE '%'||b.norm_name||'%'
         OR b.norm_name LIKE '%'||a.norm_name||'%')))
    ORDER BY score DESC,a.store_name,b.store_name LIMIT 120
   ) p
  ),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.lottery_store_review_v1(
  p_source uuid,p_target uuid,p_action text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE src private.lottery_store_master_v1%ROWTYPE;
DECLARE dest private.lottery_store_master_v1%ROWTYPE;
BEGIN
 IF (SELECT auth.uid()) IS DISTINCT FROM
   '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid
 THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_source IS NULL OR p_target IS NULL OR p_source=p_target
   OR p_action NOT IN ('merge','separate')
 THEN RAISE EXCEPTION 'Invalid review request'; END IF;
 SELECT * INTO src FROM private.lottery_store_master_v1
  WHERE id=p_source FOR UPDATE;
 SELECT * INTO dest FROM private.lottery_store_master_v1
  WHERE id=p_target FOR UPDATE;
 IF src.id IS NULL OR dest.id IS NULL OR
    src.prefecture<>dest.prefecture OR
    src.merged_into IS NOT NULL OR dest.merged_into IS NOT NULL
 THEN RAISE EXCEPTION 'Store location mismatch or already merged'; END IF;
 IF p_action='merge' THEN
   UPDATE private.lottery_store_master_v1
    SET merged_into=p_target,updated_at=now() WHERE id=p_source;
 ELSE
   INSERT INTO private.lottery_store_pair_review_v1(left_id,right_id)
   VALUES(least(p_source,p_target),greatest(p_source,p_target))
   ON CONFLICT(left_id,right_id) DO UPDATE SET reviewed_at=now();
 END IF;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.lottery_store_admin_v1() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.lottery_store_admin_v1() TO authenticated;
REVOKE ALL ON FUNCTION public.lottery_store_review_v1(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.lottery_store_review_v1(uuid,uuid,text) TO authenticated;
