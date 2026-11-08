import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {parseWonder,parseShinseido,findAddresses,syncAddresses,fetchOfficialPage,WONDER_URL}
  from '../supabase/functions/lottery-store-sync/address-sync.mjs';

const wonder=(name,address)=>`<dt><a>${name}</a></dt><dd>住所：${address}<br>TEL：000-0000</dd>`;
const shin=(name,address)=>`<li class="shop-item"><h2><span></span>${name}</h2><table><tr><th>所在地</th><td>${address}</td></tr></table><ul><li>電話</li></ul></li>`;
const sample=wonder('Duel Stade Ganryu つくば店<small>（WonderGOO PLUS＋ つくば店内）</small>','茨城県つくば市研究学園7丁目54-1')+
  wonder('WonderGOO ひたちなか店','茨城県ひたちなか市中根3325-10');
const shop={name:'WonderGOOつくば店',prefecture:'茨城県'};
assert.deepEqual(parseWonder(sample).map(row=>row.name),['WonderGOOつくば店','Ganryuつくば店','WonderGOOひたちなか店']);
assert.equal(parseWonder(sample)[2].address,'茨城県ひたちなか市中根3325-10','Each address stays with its own shop');
assert.equal(parseWonder(wonder('WonderGOO架空店','<script>茨城県架空市1-1</script>')).length,0);
const shinRows=parseShinseido(shin('試験一号店','千葉県市川市1-1')+shin('試験二号店','千葉県船橋市2-2'),
  'https://shinseido.co.jp/shop/list/chiba/');
assert.deepEqual(shinRows.map(row=>[row.name,row.address]),[
  ['新星堂試験一号店','千葉県市川市1-1'],['新星堂試験二号店','千葉県船橋市2-2']]);
assert.equal(parseShinseido(shin('試験店','東京都千代田区1-1'),'https://evil.example/').length,0);

let calls=[];
const load=async url=>{calls.push(url);return sample;};
let result=await findAddresses([shop,{name:'Ｇａｎｒｙｕ つくば店',prefecture:'茨城県'},
  {name:'WonderGOOつくば店',prefecture:'東京都'},{name:'つくば店',prefecture:'茨城県'},
  {...shop,address:'茨城県手動入力済み1-1'}, {...shop,merged_into:'canonical'}],load);
assert.equal(calls.length,1,'Only one shared official page is needed');
assert.equal(result.rows.length,2,'Exact width/space aliases accepted, other prefectures and incomplete names rejected');
assert.equal(result.rows[1].name,'Ｇａｎｒｙｕ つくば店','Send the exact master name to guarded SQL');
assert(result.rows.every(row=>row.source_url===WONDER_URL));
assert.equal(result.unresolved,2);

result=await findAddresses([shop],async()=>sample+wonder('WonderGOOつくば店','茨城県つくば市別住所99-1'));
assert.equal(result.rows.length,0,'Conflicting branch addresses must not be guessed');
result=await findAddresses([{name:'新星堂試験一号店',prefecture:'千葉県'},shop],async url=>{
  if(url===WONDER_URL)throw Error('directory temporarily unavailable');
  return shin('試験一号店','千葉県市川市1-1');
});
assert.equal(result.rows.length,1,'One failed site does not discard other valid addresses');
assert.equal(result.errors.length,1);
result=await findAddresses([shop],async()=>'<title>メンテナンス</title>');
assert.equal(result.rows.length,0);assert.equal(result.errors.length,1);

calls=[];
result=await findAddresses([{name:'ＴＳＵＴＡＹＡ東仙台店 ２階トレカコーナー',prefecture:'宮城県'},
  {name:'TSUTAYA東仙台店 別館',prefecture:'宮城県'},
  {name:'TSUTAYA東仙台店 ２階トレカコーナー',prefecture:'東京都'},
  {name:'インター',prefecture:'栃木県'}],async()=>assert.fail('Reviewed references require no search'));
assert.equal(result.rows.length,1,'Only the explicitly verified branch alias is accepted');
assert.match(result.rows[0].source_url,/^https:\/\/map\.pokemon-card\.com\//);
await assert.rejects(()=>findAddresses(Array(1201).fill(shop)),/Unexpected pending/);
await assert.rejects(()=>fetchOfficialPage('http://127.0.0.1/'),/Unsupported official/);
await assert.rejects(()=>fetchOfficialPage('https://www.wonder.co.jp/redirect?url=https://evil.example/'),/Unsupported official/);
await findAddresses([{name:'WonderGOOhttps://private.example/token=secret',prefecture:'茨城県'}],async url=>{
  assert.equal(url,WONDER_URL,'Never transmit store text in outbound search URLs');return sample;
});

calls=[];
const client={rpc:async(name,args)=>{
  calls.push([name,args]);
  if(name==='lottery_store_address_pending_v1')return {data:[shop],error:null};
  assert.equal(name,'lottery_store_address_fill_v1');
  assert.deepEqual(args.p_stores,[{...shop,address:'茨城県つくば市研究学園7丁目54-1',source_url:WONDER_URL}]);
  return {data:{updated:1},error:null};
}};
assert.deepEqual(await syncAddresses(client,load),{pending:1,matched:1,updated:1,unresolved:0,sources:1,errors:[]});
assert.equal(calls.filter(row=>Array.isArray(row)&&row[0]==='lottery_store_address_fill_v1').length,1);
await assert.rejects(()=>syncAddresses({rpc:async()=>({error:{message:'permission denied'}})},load),
  error=>error.message==='permission denied');
await assert.rejects(()=>syncAddresses({rpc:async name=>name.endsWith('pending_v1')
  ?{data:[shop]}:{data:{updated:99}}},load),/Invalid saved address count/);
await syncAddresses({rpc:async name=>{assert.equal(name,'lottery_store_address_pending_v1');return {data:[]};}},
  ()=>assert.fail('No pending shops should make no external requests'));

const sql=fs.readFileSync(new URL('../supabase/lottery_store_auto_addresses_v1.sql',import.meta.url),'utf8');
assert.match(sql,/m\.store_name=rows\.name AND m\.prefecture=rows\.prefecture/);
assert.match(sql,/m\.merged_into IS NULL AND nullif\(btrim\(m\.address\),''\) IS NULL/);
assert.equal((sql.match(/Service role only/g)||[]).length,2);
assert.equal((sql.match(/FROM PUBLIC,anon,authenticated/g)||[]).length,2);
assert.doesNotMatch(sql,/GRANT[^;]*TO (?:anon|authenticated)/i);
assert.match(sql,/Conflicting store addresses/);
// Exercise the deployed request handler without contacting a site or database.
const entry=stripTypeScriptTypes(fs.readFileSync(new URL('../supabase/functions/lottery-store-sync/index.ts',import.meta.url),'utf8'))
  .replace(/^import[^;]*;\s*/gm,'');
let handler,mode='ok',synced=0,downloaded=0,ingested=0,ingestionRows=[];
vm.runInNewContext(entry,{Deno:{env:{get:name=>({NOTIFY_SECRET:'test-only',SUPABASE_URL:'https://example.invalid',
  SUPABASE_SERVICE_ROLE_KEY:'mock-only'}[name])},serve:fn=>{handler=fn;}},Request,Response,AbortController,setTimeout,clearTimeout,
  console:{log(){},error(){}},createClient:()=>({rpc:async(name,args)=>{
    assert.equal(name,'lottery_store_ingest_public_v1');
    if(mode!=='location-policy')assert.equal(args.p_stores.length,1);
    ingestionRows=args.p_stores;ingested++;
    return {data:1};}}),syncAddresses:async()=>{synced++;if(mode==='address-error')throw Error('address save failed');return {updated:1};},
  fetch:async url=>{downloaded++;
    if(mode==='location-policy'){
      const verified=(code,name,source='livepocket_official_page')=>({url:'https://livepocket.jp/e/'+code,
        store_location_url:'https://livepocket.jp/e/'+code,store_location_source:source,
        store_name:name,prefecture:'栃木県'});
      return Response.json({items:url.includes('/livepocket_public.json')?[
        {url:'https://livepocket.jp/e/wrong123',store_name:'Discordの別店舗',prefecture:'東京都'},
        verified('page123','公式店舗'),verified('manual123','手動確認店舗','livepocket_verified_manual'),
        {...verified('copied123','別イベントの店舗'),store_location_url:'https://livepocket.jp/e/other123'}
      ]:[{url:'https://customform.jp/form/input/123',store_name:'外部抽選店舗',prefecture:'栃木県'},
        {url:'https://livepocket.jp/e/wrong123',store_name:'Discordの別店舗',prefecture:'東京都'}]});
    }
    return mode==='catalog-error'?new Response('',{status:503}):
    Response.json({items:[{store_name:'公開テスト店舗',prefecture:'栃木県'}]});}});
const request=(method='POST',authorized=true)=>new Request('https://example.invalid/sync',{method,
  headers:authorized?{'x-notify-secret':'test-only'}:{}});
assert.equal((await handler(request('POST',false))).status,401);
assert.equal((await handler(request('GET'))).status,405);
assert.equal(downloaded,0);assert.equal(synced,0);assert.equal(ingested,0);
let response=await handler(request());
assert.equal(response.status,200);assert.equal((await response.json()).addresses.updated,1);
assert.equal(synced,1);assert.equal(ingested,1);
mode='catalog-error';response=await handler(request());
assert.equal(response.status,502);assert.equal((await response.json()).addresses.updated,1);
assert.equal(synced,2,'Manual master addresses still sync when public catalogs are down');
assert.equal(ingested,1);
mode='address-error';response=await handler(request());
assert.equal(response.status,200);assert.equal((await response.json()).addresses.error,'address save failed');
mode='location-policy';response=await handler(request());
assert.equal(response.status,200);
assert.equal((await response.json()).unverifiedLivePocketLocations,3);
assert.deepEqual(Array.from(ingestionRows,row=>row.name).sort(),['公式店舗','外部抽選店舗','手動確認店舗'].sort(),
  'Only same-event page/manual facts enter the LivePocket store master; other lottery sources still work');
console.log('Store addresses: official parsers, branch/prefecture matching, conflicts, retained manual edits, partial sources, service-only writes and empty runs passed');
