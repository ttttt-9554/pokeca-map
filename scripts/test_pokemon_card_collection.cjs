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
const sets = [{official_group_id:961,product_id:'master',title:'30th CELEBRATION'}];
const quantities = new Map();
const wanted = new Map();
const pendingWrites = [];
let loseResponse = false;
let holdWrite = false;
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
        return {order(){return this},range(start,end){return Promise.resolve({data:cards.slice(start,end+1).map(card=>({...card,quantity:quantities.get(user+':'+card.card_id)||0,wanted:wanted.get(user+':'+card.card_id)||false}))})}};
      }
      if(name==='pokemon_card_wanted_set_v1'){
        const key=user+':'+args.p_card_id;
        wanted.set(key,args.p_wanted);
        if(holdWrite)return new Promise(resolve=>pendingWrites.push(()=>resolve({data:args.p_wanted})));
        if(loseResponse){loseResponse=false;return Promise.reject(new Error('response lost'));}
        return Promise.resolve({data:args.p_wanted});
      }
      assert.equal(name,'pokemon_card_quantity_adjust_v1');
      assert.ok(user);
      const key=user+':'+args.p_card_id;
      const quantity=Math.max(0,(quantities.get(key)||0)+args.p_delta);
      quantities.set(key, quantity);
      if (holdWrite) return new Promise(resolve=>pendingWrites.push(()=>resolve({data:quantity})));
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
  const stableRows=ui.list();
  const stableImages=watchImages(ui);
  holdWrite=true;
  stableRows[0].querySelector('button[data-card-delta="1"]').click();
  stableImages.check();
  assert.equal(stableRows[0].querySelector('button[data-card-delta="1"]').disabled,true);
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
  assert.equal(ui.list()[0].querySelector('input').disabled,true);
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
  console.log('Stable images during quantity/wanted saves, paging, refresh, recovery and filtering. Thumbnails (distinct prints, lazy loading, fallback and official links) + UI: product link, kana/number search, paging, quantities, reload, filtering, lost response and sign-out passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
