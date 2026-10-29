#!/usr/bin/env node
'use strict';
// The role check is now mandatory during login; this verifies that its UI
// does not revert to an optional, test-only authentication feature.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
assert.match(html,/id="discordRoleCheck"[^>]*disabled/);
assert.match(html,/id="discordRoleStatus"/);
assert.match(html,/🔐 Discordロール認証/);
assert.match(html,/ロールを持たないアカウントはログイン状態を維持できません/);
assert.doesNotMatch(html,/アクセス権限の確認（テスト）/);
assert.match(app,/get\('discordRoleCheck'\)\.addEventListener\('click',checkDiscordRoleAccess\)/);
assert.match(app,/onAuthStateChange\(\(event,session\)/);
assert.match(app,/await requireDiscordRole\(data\.session\)/);
assert.match(app,/async function discordRoleVerifyToken\(accessToken\)/);
assert.match(app,/async function checkDiscordRoleAccess\(\)/);
assert.match(app,/getSession\(\)/);
assert.match(app,/Authorization':'Bearer '\+accessToken/);
assert.match(app,/discord-role-access/);
assert.match(app,/await supabaseClient\.auth\.signOut\(\)/);
assert.doesNotMatch(app,/console\.log\(accessToken\)/);
console.log('Mandatory Discord login role check UI and session hooks verified');
