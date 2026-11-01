-- v21.157: Developer-verified LivePocket region-only corrections
-- can add the effective one-store pair to the private store master without
-- pinning the public-catalog store name in the location override.
CREATE OR REPLACE FUNCTION public.lottery_store_register_verified_region_v1(
  p_event_url text, p_store_name text, p_prefecture text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_id uuid;
BEGIN
  IF (SELECT auth.uid()) IS DISTINCT FROM
       '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_event_url IS NULL
     OR p_event_url !~ '^https://livepocket[.]jp/e/[a-zA-Z0-9_-]{4,64}/?$'
     OR NOT EXISTS (
       SELECT 1 FROM public.livepocket_location_overrides l
       WHERE l.event_url = p_event_url
         AND l.prefecture = p_prefecture
         AND l.evidence IN ('official_page_viewed',
                            'official_screenshot_viewed',
                            'official_store_notice_viewed')
     ) THEN
    RETURN false;
  END IF;

  IF private.lottery_store_norm_v1(p_store_name) IN
      ('tsutaya','竜星のpao','pao','イエローサブマリン店',
       '古本市場','ふるいち','ゲオ','カードラボ',
       'ブックオフ','ワンダーグー','wondergoo') THEN
    RETURN false;
  END IF;

  v_id := private.lottery_store_add_v1(p_store_name,p_prefecture);
  RETURN v_id IS NOT NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.lottery_store_register_verified_region_v1(text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_store_register_verified_region_v1(text,text,text)
  TO authenticated;
