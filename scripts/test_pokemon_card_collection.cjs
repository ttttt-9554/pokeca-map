const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'),'utf8');
const js = fs.readFileSync(process.env.POKEMON_CARD_MODULE || path.join(root, 'pokemon_card_collection_v1.js'),'utf8');
const uid = ['first-user','second-user'];
const cards = [
  {card_id:50640,name:'ピカチュウ',set_code:'M6a',card_number:'028/103',sort_order:1,official_image_path:'/assets/images/card_images/large/M6a/050640_P_PIKACHIXYUU.jpg'},
  {card_id:50658,name:'ピカチュウ',set_code:'M6a',card_number:'046/103',sort_order:2,official_image_path:'/assets/images/card_images/large/M6a/050658_P_PIKACHIXYUU.jpg'},
  ...Array.from({length:40}, (_,i)=>({card_id:51000+i,name:'基本エネルギー',set_code:'M6a',card_number:null,sort_order:3+i}))];
const sets = [
  {official_group_id:999,product_id:'unknown',title:'発売日不明',catalog_products:null},
  {official_group_id:955,product_id:'older',title:'旧パック',catalog_products:{release_date:'2026-07-31'}},
  {official_group_id:961,product_id:'master',title:'30th CELEBRATION',catalog_products:{release_date:'2026-09-16'}}
];
const quantities = new Map();
const wanted = new Map();
const pendingWrites = [];
let loseResponse = false;
let holdWrite = false;
let failRecovery = false;
let rejectWrite = false;
const writeCalls = [];
const tick = () => new Promise(resolve=>setImmediate(resolve));
function start(initialUser){
  const dom = new JSDOM(html,{runScripts:'outside-only',url:'https://ttttt-9554.github.io/pokeca-map/'});
  const w = dom.window;
  const $ = id=>w.document.getElementById(id);
  const list=() => Array.from($('pokemonCardList').children);
  let user = initialUser, activeTab = 'infoPlaza';
  const client = {
    from(table){
      assert.equal(table,'pokemon_card_sets_v1');
      return {select(){return this},order(k){return k==='official_group_id'?Promise.resolve({data:sets}):this}};
    },
    rpc(name,args){
      if(name==='pokemon_card_set_search_v2'){
        assert.equal(args.p_group_id,961);
        assert.ok(user);
        let matching = [...cards].reverse();
        return {order(){return this},eq(key,value){assert.equal(key,'card_id');matching=cards.filter(card=>card.card_id===value);return this},range(start,end){
          if(failRecovery){failRecovery=false;return Promise.reject(new Error('read unavailable'));}
          return Promise.resolve({data:matching.slice(start,end+1).map(card=>({...card,quantity:quantities.get(user+':'+card.card_id)||0,wanted:wanted.get(user+':'+card.card_id)||false}))});
        }};
      }
      writeCalls.push({user,name,...args});
      if(rejectWrite){rejectWrite=false;return Promise.resolve({data:null,error:{message:'write rejected'}});}
      if(name==='pokemon_card_wanted_set_v1'){
        const key=user+':'+args.p_card_id;
        wanted.set(key,args.p_wanted);
        if(holdWrite)return new Promise((resolve,reject)=>pendingWrites.push(error=>error?reject(error):resolve({data:args.p_wanted})));
        if(loseResponse){loseResponse=false;return Promise.reject(new Error('response lost'));}
        return Promise.resolve({data:args.p_wanted});
      }
      assert.equal(name,'pokemon_card_quantity_adjust_v1');
      assert.ok(user);
      const key=user+':'+args.p_card_id;
      const quantity=Math.min(9999,Math.max(0,(quantities.get(key)||0)+args.p_delta));
      quantities.set(key, quantity);
      if (holdWrite) return new Promise((resolve,reject)=>pendingWrites.push(error=>error?reject(error):resolve({data:quantity})));
      if (loseResponse) {loseResponse=false;return Promise.reject(new Error('response lost'));}
      return Promise.resolve({data:quantity});
    }
  };
  w.eval(js);
  const feature=w.TorecaPokemonCards;
  const navigate=tab=>{
    activeTab=tab;
    $('pokemonCardsView').hidden=tab!=='pokemonCards';
    feature.onTabChanged(tab);
  };
  feature.init({getClient:()=>client,getUserId:()=>user,navigate});
  const input=(value)=>{$('pokemonCardSearch').value=value;$('pokemonCardSearch').dispatchEvent(new w.Event('input'))};
  const filter=(value)=>{$('pokemonCardOwnedFilter').value=value;$('pokemonCardOwnedFilter').dispatchEvent(new w.Event('change'))};
  return {dom,$,list,input,filter,feature,tab:()=>activeTab,changeUser(next){if(!next)navigate('group');user=next;feature.onAuthChanged();}};
}

function watchImages(ui, images = Array.from(ui.$('pokemonCardList').querySelectorAll('img'))){
  const records = [];
  const observer = new ui.dom.window.MutationObserver(batch => records.push(...batch));
  observer.observe(ui.$('pokemonCardList'), {subtree:true, childList:true, attributes:true, attributeFilter:['src','srcset']});
  return {
    check(){
      records.push(...observer.takeRecords());
      for(const img of images){
        assert.ok(img.isConnected, 'a displayed image was replaced during a state update');
        for(const record of records){
          assert.ok(!(record.type==='attributes' && record.target===img), 'an image source was reassigned');
          for(const node of record.removedNodes){
            assert.ok(node!==img && !node.contains(img), 'an existing image was detached and reinserted');
          }
        }
      }
      records.length=0;
    },
    close(){observer.disconnect();}
  };
}

(async()=>{
  let ui = start('');
  assert.equal(ui.$('openPokemonCards').hidden,true);
  ui.changeUser(uid[0]);
  await tick();
  assert.equal(ui.$('openPokemonCards').hidden,false);
  assert.equal(ui.feature.hasProduct('master'),true);
  ui.feature.open('master');
  assert.equal(ui.tab(),'pokemonCards');
  assert.equal(ui.$('pokemonCardsBack').textContent,'← 商品マスター');
  await tick();
  assert.equal(ui.list().length,40);
  assert.deepEqual(Array.from(ui.$('pokemonCardSet').options, option=>option.value), ['961','955','999']);
  assert.match(ui.list()[0].textContent, /028\/103/);
  assert.match(ui.list()[1].textContent, /046\/103/);
  const stableRows=ui.list();
  const stableImages=watchImages(ui);
  holdWrite=true;
  stableRows[0].querySelector('button[data-card-delta="1"]').click();
  stableImages.check();
  assert.equal(stableRows[0].querySelector('button[data-card-delta="1"]').disabled,false);
  assert.match(stableRows[0].textContent,/1枚/,'quantity responds before the network reply');
  pendingWrites.shift()(); await tick();
  stableImages.check();
  assert.match(stableRows[0].textContent,/1枚/);
  holdWrite=false;
  stableRows[0].querySelector('button[data-card-delta="-1"]').click();await tick();
  stableImages.check();
  for(let i=0;i<stableRows.length;i++) assert.equal(ui.list()[i],stableRows[i]);
  let images=ui.$('pokemonCardList').querySelectorAll('img');
  assert.equal(images.length,2);
  assert.notEqual(images[0].src,images[1].src);
  assert.equal(images[0].loading,'lazy');
  assert.equal(images[0].width,110);
  assert.deepEqual(Array.from(ui.list()[0].children,el=>el.className),[
    'pokemon-card-thumbnail','pokemon-card-name','pokemon-card-number','pokemon-card-quantity','pokemon-card-wanted'
  ]);
  const want=()=>ui.list()[0].querySelector('input[data-card-wanted]').click();
  want();
  assert.equal(ui.list()[0].querySelector('input').checked,true);
  assert.equal(ui.list()[0].querySelector('input').disabled,false);
  await tick();
  assert.equal(wanted.get(uid[0]+':50640'),true);
  stableImages.check();stableImages.close();
  ui.filter('wanted');
  assert.deepEqual(ui.list().map(row=>row.dataset.cardId),['50640']);
  loseResponse=true;
  want(); await tick(); await tick();
  assert.equal(ui.list().length,0);
  ui.filter('all');
  want(); await tick();
  const refreshingImages=watchImages(ui);
  ui.$('pokemonCardsRefresh').click();await tick();
  refreshingImages.check();refreshingImages.close();
  assert.equal(ui.list()[0].querySelector('input').checked,true);

  assert.equal(ui.list()[2].querySelector('.pokemon-card-thumbnail').textContent,'画像なし');
  images=ui.$('pokemonCardList').querySelectorAll('img');
  images[0].dispatchEvent(new ui.dom.window.Event('error'));
  assert.equal(ui.list()[0].querySelector('.pokemon-card-thumbnail').textContent,'画像なし');
  assert.match(ui.list()[0].querySelector('.pokemon-card-thumbnail').href,/card\/50640\/regu\/all$/);
  ui.input('ピカチュウ');
  assert.equal(ui.list()[0].querySelector('img'),null);
  ui.input('');
  const healthyImage=ui.list()[1].querySelector('img');
  ui.$('pokemonCardsRefresh').click();await tick();
  assert.ok(ui.list()[0].querySelector('img'),'explicit refresh retries failed images');
  assert.equal(ui.list()[1].querySelector('img'),healthyImage,'refresh keeps healthy images attached');
  const pagingImages=watchImages(ui);
  ui.$('pokemonCardsMore').click();
  pagingImages.check();pagingImages.close();
  assert.equal(ui.list().length,42);
  ui.input('ぴかちゅう');
  assert.equal(ui.list().length,2);
  ui.input('Ｍ６ａ ０２８ ／ １０３');
  assert.equal(ui.list().length,1);
  assert.equal(ui.list()[0].querySelector('a').href,'https://www.pokemon-card.com/card-search/details.php/card/50640/regu/all');
  ui.input('28');
  assert.equal(ui.list().length,1);
  const add=()=>ui.list()[0].querySelector('button[data-card-delta="1"]').click();
  add(); await tick();
  assert.match(ui.$('pokemonCardSummary').textContent,/1 \/ 42種類 所持 · 計1枚/);
  ui.input('');
  ui.filter('owned');
  assert.deepEqual(ui.list().map(row=>row.dataset.cardId),['50640']);
  const recoveryImages=watchImages(ui);
  loseResponse=true;
  add(); await tick(); await tick();
  recoveryImages.check();recoveryImages.close();
  assert.match(ui.$('pokemonCardStatus').textContent,/保存結果を再取得/);
  assert.match(ui.list()[0].textContent,/2枚/);
  assert.equal(quantities.get(uid[0]+':50640'),2);
  assert.equal(wanted.get(uid[0]+':50640'),true);
  ui.dom.window.close();
  ui=start(uid[0]);
  ui.$('openPokemonCards').click();
  await tick();
  assert.match(ui.list()[0].textContent,/2枚/);
  assert.equal(ui.list()[0].querySelector('input').checked,true);
  ui.filter('missing');
  assert.ok(ui.list().every(row=>row.dataset.cardId!=='50640'));
  ui.filter('owned');
  holdWrite = true;
  add();
  ui.changeUser('');
  ui.changeUser(uid[1]);
  ui.$('openPokemonCards').click();
  await tick();
  pendingWrites.shift()();
  await tick();
  assert.match(ui.$('pokemonCardSummary').textContent,/0 \/ 42種類 所持 · 計0枚/);
  assert.match(ui.list()[0].textContent,/0枚/);
  assert.equal(ui.list()[0].querySelector('input').checked,false);
  holdWrite=false;
  add();await tick();
  ui.filter('owned');
  ui.list()[0].querySelector('button[data-card-delta="-1"]').click();await tick();
  assert.equal(ui.list().length,0);
  assert.match(ui.$('pokemonCardSummary').textContent,/0 \/ 42種類 所持 · 計0枚/);
  ui.filter('all');
  holdWrite=true;
  ui.list()[0].querySelector('input').click();
  ui.changeUser('');ui.changeUser(uid[0]);ui.$('openPokemonCards').click();await tick();
  pendingWrites.shift()();await tick();
  assert.equal(ui.list()[0].querySelector('input').checked,true);
  assert.match(ui.list()[0].textContent,/3枚/);
  holdWrite=false;
  ui.dom.window.close();
  ui=start(uid[1]);ui.$('openPokemonCards').click();await tick();
  ui.filter('missing');
  const unchangedRow=ui.list()[1];
  const filterImages=watchImages(ui,[unchangedRow.querySelector('img')]);
  ui.list()[0].querySelector('button[data-card-delta="1"]').click();await tick();
  filterImages.check();filterImages.close();
  assert.equal(ui.list()[0],unchangedRow,'removing a newly owned card preserves the next card');
  assert.ok(ui.list().every(row=>row.dataset.cardId!=='50640'));
  const unchangedThird=ui.list()[1];
  cards[1].name='ピカチュウ（更新済み）';
  ui.$('pokemonCardsRefresh').click();await tick();
  assert.equal(ui.list()[0].querySelector('strong').textContent,'ピカチュウ（更新済み）');
  assert.equal(ui.list()[1],unchangedThird,'catalog changes update only the changed card');
  ui.dom.window.close();

  ui=start('rapid-user');ui.$('openPokemonCards').click();await tick();
  const rapidRows=ui.list();
  const plus=rapidRows[0].querySelector('[data-card-delta="1"]');
  const minus=rapidRows[0].querySelector('[data-card-delta="-1"]');
  const checkbox=rapidRows[0].querySelector('input');
  const quantity=()=>rapidRows[0].querySelector('.pokemon-card-quantity span').textContent;
  const rapidImages=watchImages(ui);
  const mutations=[];
  const observer=new ui.dom.window.MutationObserver(batch=>mutations.push(...batch));
  observer.observe(ui.$('pokemonCardsView'),{attributes:true,childList:true,subtree:true,characterData:true});
  holdWrite=true;
  plus.click();plus.click();plus.click();minus.click();checkbox.click();checkbox.click();checkbox.click();
  assert.equal(quantity(),'2枚','all rapid taps are visible immediately');
  assert.equal(checkbox.checked,true);
  assert.equal(plus.disabled,false);
  assert.equal(minus.disabled,false);
  assert.equal(checkbox.disabled,false);
  assert.equal(pendingWrites.length,1,'one request at a time per card');
  mutations.push(...observer.takeRecords());
  const initialMutations=mutations.splice(0);
  for(const record of initialMutations){
    assert.ok(!rapidRows.slice(1).some(row=>row===record.target||row.contains(record.target)), 'an untouched card was mutated');
    if(record.type==='attributes' && record.attributeName==='disabled') assert.equal(record.target,minus,'only the zero-quantity boundary may change disabled state');
    if(record.type==='childList') assert.notEqual(record.target,ui.$('pokemonCardList'),'saving must not rebuild the grid');
    assert.ok(!['style','class'].includes(record.attributeName),'saving must not restyle the page');
  }
  rapidRows[1].querySelector('[data-card-delta="1"]').click();
  assert.equal(pendingWrites.length,2,'another card saves without waiting for the first');
  pendingWrites.pop()();await tick();
  assert.match(rapidRows[1].textContent,/1枚/);
  while(pendingWrites.length){pendingWrites.shift()();await tick();assert.equal(quantity(),'2枚','older replies must not rewind newer taps');assert.equal(checkbox.checked,true);}
  assert.equal(quantities.get('rapid-user:50640'),2);
  assert.equal(wanted.get('rapid-user:50640'),true);
  assert.equal(writeCalls.filter(call=>call.user==='rapid-user').length,8,'each tap is persisted once');
  mutations.push(...observer.takeRecords());
  for(const record of mutations){
    assert.ok(!rapidRows.slice(2).some(row=>row===record.target||row.contains(record.target)),'save replies must leave untouched cards alone');
    assert.ok(!['style','class'].includes(record.attributeName),'save replies must not restyle the page');
    if(record.type==='attributes' && record.attributeName==='disabled') {
      assert.equal(record.target,rapidRows[1].querySelector('[data-card-delta="-1"]'),'only the second card zero boundary changes');
    }
  }
  rapidImages.check();rapidImages.close();observer.disconnect();
  assert.equal(ui.$('pokemonCardStatus').textContent,'保存しました。');

  // A missing reply may hide a successful write: read this card and continue
  // only unsent taps, while leaving other cards untouched and operable.
  plus.click();plus.click();plus.click();
  assert.equal(quantity(),'5枚');
  pendingWrites.shift()(new Error('response lost'));await tick();
  assert.equal(quantity(),'5枚');
  assert.equal(pendingWrites.length,1);
  while(pendingWrites.length){pendingWrites.shift()();await tick();}
  assert.equal(quantities.get('rapid-user:50640'),5,'the uncertain increment was not duplicated');
  assert.equal(quantity(),'5枚');
  assert.match(ui.$('pokemonCardStatus').textContent,/保存結果を再取得/);

  holdWrite=false;rejectWrite=true;
  plus.click();plus.click();
  assert.equal(quantity(),'7枚');
  await tick();
  assert.equal(quantity(),'6枚','a rejected tap is rolled back while an unsent tap still saves');
  assert.equal(quantities.get('rapid-user:50640'),6);

  holdWrite=false;loseResponse=true;failRecovery=true;
  plus.click();await tick();await tick();
  assert.equal(plus.disabled,true,'only an unconfirmed card is blocked');
  assert.equal(rapidRows[1].querySelector('[data-card-delta="1"]').disabled,false);
  assert.match(ui.$('pokemonCardStatus').textContent,/保存結果を確認できません/);
  ui.$('pokemonCardsRefresh').click();await tick();
  assert.equal(plus.disabled,false);
  assert.equal(quantity(),'7枚');
  holdWrite=true;
  plus.click();plus.click();ui.$('pokemonCardsRefresh').click();
  assert.equal(quantity(),'9枚','refresh must not overwrite pending taps');
  while(pendingWrites.length){pendingWrites.shift()();await tick();}
  assert.equal(quantity(),'9枚');
  assert.equal(quantities.get('rapid-user:50640'),9);

  // Signing out cancels unsent taps, and late replies cannot write as the
  // next account or change its display.
  plus.click();plus.click();plus.click();
  const callsBeforeSignOut=writeCalls.length;
  ui.changeUser('');ui.changeUser('new-account');ui.$('openPokemonCards').click();await tick();
  pendingWrites.shift()();await tick();
  assert.equal(writeCalls.length,callsBeforeSignOut);
  assert.match(ui.list()[0].textContent,/0枚/);
  assert.equal(pendingWrites.length,0);
  holdWrite=false;
  quantities.set('new-account:50640',9998);
  ui.$('pokemonCardsRefresh').click();await tick();
  const cappedPlus=ui.list()[0].querySelector('[data-card-delta="1"]');
  cappedPlus.click();cappedPlus.click();await tick();
  assert.equal(quantities.get('new-account:50640'),9999);
  assert.equal(cappedPlus.disabled,true);
  ui.dom.window.close();
  console.log('Passed: immediate and queued quantity/wanted updates, independent cards, no unrelated DOM/style changes, stable images, bounds, recovery, refresh, auth isolation, catalog search and filtering.');
})().catch(error=>{console.error(error);process.exitCode=1});
