-- Keep a deleted spelling out of subsequent imports of historical lotteries.
CREATE TABLE private.lottery_store_exclusions_v1 (
  prefecture text NOT NULL,
  norm_name text NOT NULL,
  store_id uuid NOT NULL,
  previous_row jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (prefecture, norm_name)
);
ALTER TABLE private.lottery_store_exclusions_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.lottery_store_exclusions_v1 FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.lottery_store_skip_excluded_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM private.lottery_store_exclusions_v1
    WHERE prefecture = NEW.prefecture AND norm_name = NEW.norm_name
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.lottery_store_skip_excluded_v1() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER lottery_store_skip_excluded_v1
BEFORE INSERT ON private.lottery_store_master_v1
FOR EACH ROW EXECUTE FUNCTION private.lottery_store_skip_excluded_v1();

CREATE FUNCTION private.lottery_store_delete_v1(p_store_id uuid, p_expected_parent uuid, p_expected_children uuid[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  target private.lottery_store_master_v1%ROWTYPE;
  children uuid[];
BEGIN
  IF (SELECT auth.uid()) IS DISTINCT FROM '0ba965da-445b-4055-8d8d-ead585fa0d09'::uuid THEN
    RAISE EXCEPTION '店舗マスターを編集する権限がありません。' USING ERRCODE = '42501';
  END IF;
  IF p_store_id IS NULL OR p_expected_children IS NULL THEN
    RAISE EXCEPTION '削除する店舗を選び直してください。' USING ERRCODE = '22023';
  END IF;

  -- Serialize this infrequent admin action with imports and merge changes.
  LOCK TABLE private.lottery_store_master_v1 IN EXCLUSIVE MODE;
  SELECT * INTO target FROM private.lottery_store_master_v1 WHERE id = p_store_id;
  IF NOT FOUND THEN
    RETURN EXISTS (SELECT 1 FROM private.lottery_store_exclusions_v1 WHERE store_id = p_store_id);
  END IF;
  SELECT ARRAY(SELECT id FROM private.lottery_store_master_v1 WHERE merged_into = p_store_id ORDER BY id) INTO children;
  IF target.merged_into IS DISTINCT FROM p_expected_parent OR children IS DISTINCT FROM
      ARRAY(SELECT child FROM pg_catalog.unnest(p_expected_children) AS child ORDER BY child) THEN
    RAISE EXCEPTION '店舗の統合状態が変わりました。一覧を更新して、もう一度確認してください。' USING ERRCODE = '40001';
  END IF;

  INSERT INTO private.lottery_store_exclusions_v1 (prefecture, norm_name, store_id, previous_row)
    VALUES (target.prefecture, target.norm_name, target.id, pg_catalog.to_jsonb(target));
  UPDATE private.lottery_store_master_v1 SET merged_into = target.merged_into, updated_at = now()
    WHERE merged_into = target.id;
  DELETE FROM private.lottery_store_master_v1 WHERE id = target.id;
  RETURN true;
END;
$$;

-- The invoker wrapper binds to the private function at definition time.
CREATE FUNCTION public.lottery_store_delete_v1(p_store_id uuid, p_expected_parent uuid, p_expected_children uuid[])
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path = ''
BEGIN ATOMIC
  SELECT private.lottery_store_delete_v1(p_store_id, p_expected_parent, p_expected_children);
END;
REVOKE ALL ON FUNCTION private.lottery_store_delete_v1(uuid,uuid,uuid[]),
  public.lottery_store_delete_v1(uuid,uuid,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.lottery_store_delete_v1(uuid,uuid,uuid[]),
  public.lottery_store_delete_v1(uuid,uuid,uuid[]) TO authenticated;
NOTIFY pgrst, 'reload schema';
