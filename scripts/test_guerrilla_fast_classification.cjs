const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Run the live Edge Function's actual classification against offline examples.
const source = fs.readFileSync(path.join(__dirname,
  '../supabase/functions/guerrilla-fast-monitor/index.ts'), 'utf8');
const start = source.indexOf('const SITE=');
const end = source.indexOf('function robotsAllows(');
assert.ok(start >= 0 && end > start);
const classification = source.slice(start, end)
  .replace('(v:any)', '(v)')
  .replace('function kind(text:string)', 'function kind(text)');
const context = {};
vm.runInNewContext(classification + '\nglobalThis.classify = kind;', context);
const classify = context.classify;

for (const title of [
  'ONE PIECE ブースターパック BOX 在庫数 3点',
  'UNION ARENA ブースターパック BOX 在庫数 1箱',
  'ポケモンカードゲーム 拡張パック 在庫数 1パック',
]) assert.equal(classify(title), 'pack', title);
assert.equal(classify('ポケモンカードゲーム スターターセット 在庫数 3点'), 'deck');

for (const title of [
  'ワンピースカードゲーム ブースターパック BOX 在庫数 3枚',
  'ポケカ 拡張パック BOX 在庫数：1,200枚',
  '(予約) ポケカ 拡張パック BOX 在庫数 3点',
  'ポケカ 14枚セット 拡張パック BOX 在庫数 2点',
  'ポケカ デッキケース 在庫数 3点',
]) assert.equal(classify(title), '', title);

console.log('Fast monitor classification: sealed items accepted, singles and reservations excluded');
