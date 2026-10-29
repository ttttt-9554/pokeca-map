# Toreca Radar: Discordロールによるログイン制限（有効）

**運用範囲:** Discord OAuthでログインしても、指定Guild/RoleをBotで確認できない場合はアプリが即時ログアウトします。GitHub Pagesや公開JSONへの匿名アクセス自体は遮断しません。Supabaseの権限体系（RLS）は未変更です。

対象サーバーID: `1551557658618896444`、許可ロールID: `1565321684603637890`。既存のURL収集用Botではなく、新設した `Toreca Radar Auth` BotのSecretsを使用します。

- 起動時に既存セッションも再審査し、ロール確認成功前は `authUser` をセットしない。
- 新規Discordログイン時に `discord-role-access` Edge Functionで認証。
- 不正ロール・サーバー未参加・認証サーバー障害時はログイン拒否・ログアウト。
- ログイン後も表示中は90秒ごとおよびウィンドウ復帰時に再審査。
- ロール認証の成功・失敗で既存の個人応募データは削除しない。
- 画面操作やログイン機能の制限です。公開データの完全な非公開化ではありません。

# 以前の構成と非公開化メモ（参考）

## 重要
現状の GitHub Pages・公開リポジトリ・公開JSON・Supabaseの公開読み込みは **誰でもアクセス可能** です。
アプリ画面にログインオーバーレイを付けるだけでは外部への情報公開を止められません。
この段階では **既存ユーザーと既存データへのアクセス制限を変更していません**。

## 作成済み
- `discord-role-access` Edge Function: 認証済み Supabase ユーザーのDiscord本人識別子からBot APIで役割を照合。メンバーの `pending` も拒否する。ロールが無ければ403。Discord APIや設定に問題があれば503で失敗扱い。
- `discord_role_access_v1`: サーバー側だけが書き込める120秒間の許可キャッシュと `discord_role_allowed_v1()`。現段階ではRLSへの組み込みなし。

## 有効化前に必要な情報と操作
1. **サーバーID 1551557658618896444 とロールID 1565321684603637890 は認証サーバーコードに設定済み**。再送不要。将来ほかのロールも使う場合は `DISCORD_ALLOWED_ROLE_IDS` で上書きできる。
2. 新設した**Toreca Radar Auth** Botは対象サーバーに追加済み。LivePocket URL収集用Botとは別管理であり、GitHub Actions側は変更しない。
3. Supabase Dashboard → Edge Functions → Secretsで **認証専用Botのトークン**を `DISCORD_BOT_TOKEN` として設定。**トークンをチャットやGitHubのファイルに貼らない。** LivePocket収集BotのGitHub Actions Secretは変更不要。任意で `APP_ALLOWED_ORIGINS` に現在のアプリOriginを設定。
4. アプリ上部「ログイン」→ Discordログイン →「Discordロールを確認」を押して本人の認証テストを実施。許可ロール無し・サーバー未参加・期限切れも確認する。Edge Function はJWTを Auth サービスで検証し、BotがDiscord APIから現在ロールを取得します。**テスト成功は公開データへのアクセス制限の有効化を意味しません。**
5. 公開JSONと公開コードを保護された配信元に移設し、元の GitHub Pages と公開リポジトリから取得できない状態へ切替。
6. Supabaseの公開 SELECT 等を RLS の restrictive gate で閉じ、既存のSECURITY DEFINER RPCも個別チェック後に有効化する。ロールを失った人は最大120秒以内に権限を失う構成。

**注意**: 指定Guild/Role IDの登録は完了しましたが、BotトークンのSupabaseへの安全な設定、実際のロール照合テスト、非公開ホスティング／公開データの移行は未完了です。現時点では既存の公開アプリを締め出していません。
