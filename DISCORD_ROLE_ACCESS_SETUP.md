# Toreca Radar: Discordロール制限の準備（未有効化）

## 重要
現状の GitHub Pages・公開リポジトリ・公開JSON・Supabaseの公開読み込みは **誰でもアクセス可能** です。
アプリ画面にログインオーバーレイを付けるだけでは外部への情報公開を止められません。
この段階では **既存ユーザーと既存データへのアクセス制限を変更していません**。

## 作成済み
- `discord-role-access` Edge Function: 認証済み Supabase ユーザーのDiscord本人識別子からBot APIで役割を照合。メンバーの `pending` も拒否する。ロールが無ければ403。Discord APIや設定に問題があれば503で失敗扱い。
- `discord_role_access_v1`: サーバー側だけが書き込める120秒間の許可キャッシュと `discord_role_allowed_v1()`。現段階ではRLSへの組み込みなし。

## 有効化前に必要な情報と操作
1. Discordで**開発者モード**を有効化し、対象サーバーの「IDをコピー」で `DISCORD_GUILD_ID` を調べる。
2. サーバー設定→ロールで許可するロールIDをコピー。複数はコンマ区切りで `DISCORD_ALLOWED_ROLE_IDS` に設定。
3. Supabase Dashboard → Edge Functions → Secretsで `DISCORD_GUILD_ID`, `DISCORD_ALLOWED_ROLE_IDS`, `DISCORD_BOT_TOKEN` を**サーバー秘密値**として設定。Botは対象サーバーに存在する必要があります。**トークンはチャットやGitHubには貼らない。** 任意で `APP_ALLOWED_ORIGINS` に現在のアプリOriginを設定。
4. 本人・許可ロール無し・サーバー未参加・期限切れを実テストする。Edge Function はJWTを Auth サービスで検証し、BotがDiscord APIから現在ロールを取得します。
5. 公開JSONと公開コードを保護された配信元に移設し、元の GitHub Pages と公開リポジトリから取得できない状態へ切替。
6. Supabaseの公開 SELECT 等を RLS の restrictive gate で閉じ、既存のSECURITY DEFINER RPCも個別チェック後に有効化する。ロールを失った人は最大120秒以内に権限を失う構成。

**注意**: Guild/Role IDの値が無いため、ユーザーを締め出す変更は意図的に行っていません。これは完成した非公開アプリではありません。
