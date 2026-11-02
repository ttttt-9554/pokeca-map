#!/usr/bin/env node
'use strict';
// Bic Camera URL contract in the developer console. No network requests.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const js=fs.readFileSync(path.join(__dirname,'..','guerrilla_sale_dev_v2.js'),'utf8');
const a=js.indexOf('  const SITES={');
const b=js.indexOf('  const $=',a);
const c=js.indexOf('  function canonical(value,site){');
const d=js.indexOf('  function link(url){',c);
assert(a>=0&&b>a&&c>b&&d>c,'Developer UI site/url functions must remain discoverable');
const canonical=vm.runInNewContext(
  [js.slice(a,b),js.slice(c,d),'canonical'].join('\n'),
  {URL}, {timeout:1000});
const good='https://www.biccamera.com/bc/item/15607965/';
assert.equal(canonical(good,'biccamera'),good);
assert.equal(canonical(good.slice(0,-1),'biccamera'),good);
assert.equal(canonical(good+'?utm_source=app','biccamera'),good);
assert.equal(canonical('https://www.amenitydream.com/product/273649','amenity'),
  'https://www.amenitydream.com/product/273649');
const yodobashi='https://www.yodobashi.com/product/100000001009191424/';
assert.equal(canonical(yodobashi.slice(0,-1)+'?utm_source=app','yodobashi'),yodobashi);
assert.throws(()=>canonical(yodobashi+'?variant=2','yodobashi'));
assert.throws(()=>canonical('https://www.yodobashi.com/product/123/','yodobashi'));
for(const url of [
  'http://www.biccamera.com/bc/item/15607965/',
  'https://www.biccamera.com.evil.com/bc/item/15607965/',
  'https://www.biccamera.com/bc/item/15607965/?variant=2',
  'https://www.biccamera.com/bc/cart/',
  'https://evil@www.biccamera.com/bc/item/15607965/',
]){
  assert.throws(()=>canonical(url,'biccamera'));
}
assert.match(js,/value="biccamera">ビックカメラ\.com/);
assert.match(js,/site==='biccamera'&&body\.enabled/);
assert.match(js,/function syncEditorPause\(\)/);
assert.match(js,/enabled\.disabled=paused/);
assert.match(js,/HTTP 403/);
assert.match(js,/if\(selected\.length&&key!=='pokemon'&&key!=='biccamera'\)/);
assert.doesNotMatch(js,/card\.append\(toggle\('トレカ一覧/);
assert.match(js,/yodobashi:\{name:'ヨドバシ\.com'/);
assert.match(js,/if\(key==='yodobashi'\)/);
assert.match(js,/自動監視・販売通知は停止中/);
assert.match(js,/公式カード一覧を開く/);
assert.doesNotMatch(js,/value="yodobashi"/);
console.log('Bic Camera developer controls: canonical URL, site isolation and blocked-access pause passed');
