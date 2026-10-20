-- v21.51: "全国" is a verified location scope, distinct from "未確認".
-- Keep the existing 47 prefectures and previous approved corrections intact.
-- No public write policy changes.
alter table public.livepocket_location_overrides
  drop constraint if exists lp_location_prefecture_valid;
alter table public.livepocket_location_overrides
  add constraint lp_location_prefecture_valid
  check (
    prefecture is null or prefecture in (
      '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
      '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
      '新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県',
      '静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県',
      '奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県',
      '徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県',
      '熊本県','大分県','宮崎県','鹿児島県','沖縄県','全国'
    )
  );
