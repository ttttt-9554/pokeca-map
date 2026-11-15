# トレカレーダー：Discordロール認証と14日間のログイン保持（v21.138）

## 運用状態
- Supabase Authentication の **Custom Access Token HTTP Hook** は既に有効化済み。
- 許可ロールなしのDiscordアカウントはトークン発行前にログインを拒否。
- 一度認証に成功したアプリのログイン状態はSupabase Authが端末内に保持し、自動更新する。
- 認証済みの個別ログインセッションを **14日間** サーバー側キャッシュで記録する。
- **トークン更新時**は同じセッションIDかつ有効期間内ならDiscord APIへの再照会を省略。
- 14日を過ぎた後、次にトークン更新が発生したときはロールを再照会し、問題なければ14日間延長。
- 新しい端末や新規Discord OAuthログインでは必ず初回ロール確認。
- アプリ再起動時も署名済みJWTにある期限を検証し、既存認証を復元。
- 一時的な回線切断で画面側のログイン資格をすぐ削除しない。
- **90秒ごとの自動確認は行わない。**

## 初回ログインの処理順序
- ブラウザのSupabaseクライアントは `flowType: 'pkce'` と `detectSessionInUrl: true` を指定する。
- Discordのコールバックでユーザー・認証IDの保存を確定した後、ブラウザで認証コードを交換する。このトークン発行時に既存のロール確認Hookが動く。
- implicit方式では初回ユーザーの保存が確定する前にHTTP Hookが動き、Admin APIで `User not found` になるため戻さない。
- コード交換はログインを開始したブラウザで完了させる。交換エラーは `auth.initialize()` の結果で確認し、セッション未発行時の再確認ボタンはOAuthをやり直す。
- ロール確認には引き続きAdmin APIが返す認証IDを使い、編集可能な `user_metadata` を本人確認の代用にしない。

## セキュリティ上の留意点
- 14日間の保持期間中にDiscordロールが解除されても、現在のセッションは次の確認まで継続する。緊急停止が必要な場合はSupabaseから対象ユーザーのセッションを取り消す。
- Supabase Auth自体のセッション有効性、手動ログアウト、端末ブラウザの保存領域消去などによって、14日を待たずにログアウトする場合がある。
- 元の公開GitHub Pages/JSONは公開のままであり、この機能はログイン権限に関するもの。
- URL収集Bot、抽選データ、その他の認証・RLSポリシーは変更なし。
- `public.discord_remembered_sessions_v1` はRLS有効で通常ユーザーからの直接アクセスを拒否。書き込みはSupabaseサービスロールのみ。

## 既存Auth Hook設定
- Endpoint: `https://aypcmtlaaygmiexboypk.supabase.co/functions/v1/discord-custom-access-token`
- 署名Secret: `DISCORD_ACCESS_TOKEN_HOOK_SECRET`（既存のものを維持、GitHubには保存しない）
- Bot: `Toreca Radar Auth`（URL収集用のDiscord Botとは別）
- 設定: [Auth Hooks](https://supabase.com/dashboard/project/aypcmtlaaygmiexboypk/auth/hooks)
- 初回ログインのエラーはPKCE設定と認証ログを確認する。ロール確認Hookの無効化を復旧手順にしない。

