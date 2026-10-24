# ゲリラ販売監視｜開発者専用プレビュー

## 現在の公開範囲

- 通常ユーザーにはゲリラ販売の速報パネルを表示しません。「開発」タブだけに表示します。
- Supabase `guerrilla_sale_monitor_targets` と `guerrilla_sale_monitor_snapshot` の参照は開発者UID限定のRLSで制限しています。
- `guerrilla_sale_feed.json`、`guerrilla_sale_targets.json`、公開JavaScript取得処理は削除しました。Git履歴自体は公開のままですが、削除済みファイルに実際の監視情報は含まれていません。
- バックエンドは GitHub Actions `.github/workflows/guerrilla-sale.yml` に配置していますが、動かすにはGitHub ActionsのSecret `SUPABASE_SERVICE_ROLE_KEY` が必要です。この秘密鍵はアプリやファイルに絶対に記述しないでください。
- Discord通知には専用の非公開チャンネルのWebhookを `GUERRILLA_DISCORD_WEBHOOK_URL` として登録します。公開チャンネルのWebhookを登録すると一般ユーザーにも通知されるため、テスト期間中は使用しないでください。
- 設定を完了しても対象が `enabled=false` の間は販売ページへのチェックもDiscord通知も実行しません。

## 登録済みの監視候補

| 店舗 | ホームページ | 状態 |
| --- | --- | --- |
| ポケモンセンターオンライン | https://www.pokemoncenter-online.com/ | 未有効化（対象商品未指定） |
| アメニティードリーム通販部 | https://www.amenitydream.com/ | 未有効化（対象商品未指定） |

ホームページの「カートに入れる」の文字は他の商品にも存在し得るため、**ホームページを販売開始の判定に使わない**でください。

## 検知対象の設定

1. 対象サイトの**具体的な商品ページ**を確認する。
2. 開発者用のSupabaseテーブル `guerrilla_sale_monitor_targets` の `url` と `product` を具体的な値にする。
3. `available_text` と `unavailable_text` は対象商品ページ上で販売状態ごとに実際に変わる文字を設定する。
4. `required_text` にはその商品の固有名などを入れ、別商品や共通ヘッダーの誤検知を防ぐ。
5. テストしてから `enabled=true` にする。

## 制約

- 原則約5分間隔の確認。GitHub Actionsの実行時刻は保証されません。
- 在庫なし→販売中への遷移のみアラート。最初に販売中だった場合は通知しません。
- ログインが必要なページ、JavaScriptのみで表示される在庫、仮想待合室、アクセス制限中のページには未対応です。
- Web Push（iPhoneの画面を閉じた状態で届く通知）はまだありません。
- 一般公開へ切り替えるまで、SupabaseのRLSを緩めたりパブリックJSONを再開したりしないでください。
