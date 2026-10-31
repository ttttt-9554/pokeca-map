-- Register the existing administrator chain preset in the private store master.
-- No lottery events are marked as belonging to all 22 stores here.
-- Idempotent and does not alter known user assignments or outcome statistics.
SELECT private.lottery_store_add_v1(t.name,t.prefecture)
FROM (VALUES
  ('イエローサブマリン札幌GAMESHOP','北海道'),
  ('イエローサブマリン横浜店','神奈川県'),
  ('イエローサブマリン新宿店','東京都'),
  ('イエローサブマリン池袋GAMESHOP','東京都'),
  ('イエローサブマリン町田GAMESHOP','東京都'),
  ('イエローサブマリン横浜西口店','神奈川県'),
  ('イエローサブマリン川越カードショップ','埼玉県'),
  ('イエローサブマリン大宮本店・プレイソフト','埼玉県'),
  ('イエローサブマリン千葉ゲームショップ','千葉県'),
  ('イエローサブマリン宇都宮店','栃木県'),
  ('イエローサブマリン溝口店','神奈川県'),
  ('イエローサブマリン川崎店','神奈川県'),
  ('イエローサブマリン立川店','東京都'),
  ('イエローサブマリン柏店','千葉県'),
  ('イエローサブマリン秋葉原本店★ミント','東京都'),
  ('イエローサブマリン京都店','京都府'),
  ('イエローサブマリン名古屋GAMESHOP','愛知県'),
  ('イエローサブマリンなんば本店','大阪府'),
  ('イエローサブマリン三宮店','兵庫県'),
  ('イエローサブマリン姫路店','兵庫県'),
  ('イエローサブマリンマジッカーズ福岡店','福岡県'),
  ('イエローサブマリン広島店','広島県')
) AS t(name,prefecture);
