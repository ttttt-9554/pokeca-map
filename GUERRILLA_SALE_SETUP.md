# ゲリラ販売速報（初期版）

## 現在の仕組み

- `guerrilla_sale_targets.json` に管理者が指定した **公開HTTPS商品ページ** を確認します。
- 独立したGitHub Actions `.github/workflows/guerrilla-sale.yml` を約5分ごとのスケジュールで起動します。GitHub Actionsの実行は遅延・欠落することがあります。
- 最初の確認では通知せず、**前回「売り切れ・受付前」と判定し、今回「販売表示」と判定したとき** に1件通知します。
- Discord通知先はGitHub Actions Secretの `GUERRILLA_DISCORD_WEBHOOK_URL` です。Secretが未設定ならDiscord通知は送られません。
- 結果は `guerrilla_sale_feed.json` に公開され、アプリの「抽選」→「ゲリラ販売速報」で確認できます。
- iPhoneを閉じているときのOSプッシュ通知は**未実装**です（別途Web Pushサーバー・端末ごとの購読登録・Service Workerが必要）。
- ログイン、抽選、購入、カート操作、アクセス制限回避、待合室の突破は行いません。

## 監視対象の追加

GitHub上で `guerrilla_sale_targets.json` を編集します。たとえば下記のように `targets` に追加します。

~~~json
{
  "schema_version": 1,
  "targets": [
    {
      "id": "shop-a-product-a",
      "shop": "ショップA",
      "product": "対象トレカ商品",
      "url": "https://example.com/products/item",
      "enabled": false,
      "required_text": ["対象トレカ商品"],
      "available_text": ["カートに入れる"],
      "unavailable_text": ["在庫なし", "売り切れ"],
      "cooldown_minutes": 60
    }
  ]
}
~~~

※上記のURLと店舗は **サンプル** です。そのまま有効化しないでください。

- `id` は半角英数・ハイフン・アンダースコア、2～64文字で一意にします。
- `enabled` を `true` にすると監視します（最大20件）。
- `required_text` は任意ですが、商品名などを指定すると別商品の誤判定を減らせます。
- `available_text` と `unavailable_text` は、**その店舗の実際のページ本文に出る文字**で指定してください。
- `available_text` と `unavailable_text` が両方出ている場合は通知せず「判定不能」にします。
- JavaScriptでのみ在庫を表示するページ、会員ページ、対策でブロックするサイトは判定できません。
- サイトの利用規約、robots.txt、サーバー負荷に配慮してください。対象数は必要最低限に絞ってください。

## Discord通知先

1. Discordの通知を出したいチャンネルで「チャンネルの編集」→「連携サービス」→「ウェブフック」を作成します。
2. ウェブフックURLをコピーします。
3. GitHubの `Settings → Secrets and variables → Actions → New repository secret` に進み、名前 `GUERRILLA_DISCORD_WEBHOOK_URL` で保存します。
4. **ウェブフックURLはJSONやアプリ本体に書かず、Secretにのみ保存**してください。
5. `Actions → Guerrilla Sale Status Monitor → Run workflow` で手動実行できます。初回は基準状態を記録するだけです。

## 動作確認

- `guerrilla_sale_feed.json` の `items` に監視結果が反映されるか確認。
- 「売り切れ・受付前」の状態を確認した後、実際に「販売表示」に変わった時だけ通知。
- `status=unknown` は判定語不一致・ページエラーなど。**販売確定とは扱わない**。
- 同一の販売状態が続く間は再通知しません。復活時も設定したクールダウン中は再通知しません。
- 発見後に商品が売り切れる可能性があるため、必ずリンク先で確認してください。
