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
assert.match(js,/id:'biccamera-catalog'/);
assert.match(js,/公式の巡回許可を確認できない場合/);
console.log('Bic Camera developer controls: canonical URL, site isolation and default OFF passed');
