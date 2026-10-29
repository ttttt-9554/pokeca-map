-- v21.128: include every store with at least one decided application, regardless of user count.
-- Small samples are shown as reference-only; the high-success badge keeps its 30-result threshold.
-- Private user IDs, account IDs and individual store submissions NEVER leave the server.
CREATE OR REPLACE FUNCTION public.lottery_store_stats_v1()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
WITH accounts AS (
 SELECT a.value v
 FROM public.lottery_user_entries e
 CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
  CASE WHEN pg_catalog.jsonb_typeof(e.account_entries)='array'
    THEN e.account_entries ELSE '[]'::jsonb END) a
 UNION ALL
 SELECT a.value v
 FROM public.lottery_external_user_entries e
 CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
  CASE WHEN pg_catalog.jsonb_typeof(e.account_entries)='array'
    THEN e.account_entries ELSE '[]'::jsonb END) a
), clean AS (
 SELECT
  pg_catalog.btrim(coalesce(a.v->>'store_prefecture','')) pref,
  private.lottery_store_norm_v1(a.v->>'store_name') key,
  (CASE WHEN a.v->>'won_count'='1' THEN 1 ELSE 0 END) won,
  (CASE WHEN a.v->>'lost_count'='1' THEN 1 ELSE 0 END) lost
 FROM accounts a
 WHERE a.v->>'application_count'='1'
  AND coalesce(a.v->>'won_count','0') IN ('0','1')
  AND coalesce(a.v->>'lost_count','0') IN ('0','1')
  AND NOT(a.v->>'won_count'='1' AND a.v->>'lost_count'='1')
), matched AS (
 SELECT coalesce(m.merged_into,m.id) store_id,
  clean.won,clean.lost
 FROM clean JOIN private.lottery_store_master_v1 m
   ON m.prefecture=clean.pref AND m.norm_name=clean.key
), totals AS (
 SELECT store_id,
  sum(won)::integer won,sum(lost)::integer lost,
  sum(won+lost)::integer decided,count(*)::integer applied
 FROM matched GROUP BY store_id
), eligible AS (
 SELECT s.*,m.store_name,m.prefecture,
  (s.won::numeric/nullif(s.decided,0)) rate
 FROM totals s JOIN private.lottery_store_master_v1 m ON m.id=s.store_id
 WHERE s.decided>=1
), baseline AS (
 SELECT count(*) eligible_stores,
  coalesce(sum(won),0) total_won,
  coalesce(sum(decided),0) total_decided
 FROM eligible
 WHERE decided>=20
)
SELECT coalesce(pg_catalog.jsonb_agg(
 pg_catalog.jsonb_build_object(
  'store_id',e.store_id,'store_name',e.store_name,'prefecture',e.prefecture,
  'applied',e.applied,'won',e.won,'lost',e.lost,'decided',e.decided,
  'rate',round(e.rate*100,1),
  'badge',(
    e.decided>=30 AND b.eligible_stores>=2 AND b.total_decided>=60
    AND e.rate>=(b.total_won::numeric/nullif(b.total_decided,0))+0.08
    AND e.rate>=(b.total_won::numeric/nullif(b.total_decided,0))*1.25
  ),
  'keys',(
   SELECT coalesce(pg_catalog.jsonb_agg(x.prefecture||'|'||x.norm_name),'[]'::jsonb)
   FROM private.lottery_store_master_v1 x
   WHERE coalesce(x.merged_into,x.id)=e.store_id
  )
 ) ORDER BY e.rate DESC,e.decided DESC),'[]'::jsonb)
FROM eligible e CROSS JOIN baseline b;
$$;
REVOKE ALL ON FUNCTION public.lottery_store_stats_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lottery_store_stats_v1() TO anon,authenticated;
