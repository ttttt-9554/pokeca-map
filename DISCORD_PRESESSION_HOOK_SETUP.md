# トレカレーダー：Discordロールによる「ログイン成立前」の制限

## 現在の状況
- 新しい Supabase Edge Function **discord-custom-access-token** は導入できる状態。
- 実際のSupabase **Authentication → Hooks → Custom Access Token** の有効化は別操作が必要。
- **フックを有効化するまでは、既存の「ログイン後にロールチェックして拒否」の仕組みが動作。**
- 既存のLivePocket URL収集、抽選データ、SupabaseのRLS、GitHub Pagesを変更しない。

## Auth Hookの動作
- Discordで本人確認した後、Supabase AuthがセッションJWTを作成する前に署名済みHookを呼ぶ。
- Auth内部の user_id からDiscordの連携IDをサーバー側で照合し、既存のToreca Radar Auth Botで所属ロールを確認。
- 許可ロール：`1565321684603637890` / サーバー：`1551557658618896444`。
- 許可時はJWT claimsを変更せず返す。禁止・Discord未所属・異常時はエラーを返し、トークン発行を止める。
- 90秒間隔のポーリングはしない。**トークンを発行・更新するときにはHookが実行される**。
- 既存のクライアント側のロール制限は、Hookが有効になるまで残す。

## 運用者が行う最後の設定（必須）
1. <https://supabase.com/dashboard/project/aypcmtlaaygmiexboypk/auth/hooks> を開く。
2. **Custom Access Token** の **HTTP Hook** を選択して下記URLを設定。
   `https://aypcmtlaaygmiexboypk.supabase.co/functions/v1/discord-custom-access-token`
3. 署名用Secret（`v1,whsec_...`）をダッシュボードで発行する。**このSecretをチャットやGitHubに貼らないこと**。
4. <https://supabase.com/dashboard/project/aypcmtlaaygmiexboypk/functions/secrets> で
   Name `DISCORD_ACCESS_TOKEN_HOOK_SECRET`、Valueに同じSecretを登録。
   既存の `DISCORD_BOT_TOKEN` は認証用Botのものを引き続き使用。
5. **署名用SecretをEdge Functionへ登録してから** Auth Hookを有効化する。
6. 正しいロール／ロールなし／サーバー外のユーザーを再ログインさせて確認。実際のSupabaseセッションが生成されないことを確認。
7. すべてログイン失敗になったら Auth HookをOFFにする。既存の画面側ロール判定へ戻せる。

## 注意
- このHookは *すべての新規JWT* に適用される。Auth Hookが失敗するとログイン中のユーザーもアクセストークン更新に失敗する。
- 同期HTTP Hookの処理時間には約5秒の制限がある。遅延したときは安全側に倒して拒否する。
- 初めてOAuthユーザーを作るタイミングではSupabase AuthのDBトランザクションの状況により、Auth Admin APIからidentityが読めず拒否される可能性がある。既存・新規ユーザーの両方をテストする。
- 本対応は**Discordログイン／JWT発行**の制限。GitHub Pagesの公開HTML、JSON等を秘匿する機能ではない。
