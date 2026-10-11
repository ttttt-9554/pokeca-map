
(()=>{
'use strict';

const KEY='pokeca-reports-v1';
const STORE_KEY='pokeca-tochigi-stores-v05';
const $=id=>document.getElementById(id);

let reports=[];
let stores=[];
let packs=[];
let editId=null;
let map,markers;

const escape=s=>String(s).replace(/[&<>"']/g,c=>({
 '&':'&amp;','<':'&lt;','>':'&gt;',
 '"':'&quot;',"'":'&#39;'
}[c]));

function valid(r){
 return r&&typeof r.id==='string'&&
 typeof r.shop==='string'&&
 typeof r.product==='string'&&
 typeof r.foundAt==='string'&&
 Number.isFinite(Number(r.lat))&&
 Math.abs(Number(r.lat))<=90&&
 Number.isFinite(Number(r.lng))&&
 Math.abs(Number(r.lng))<=180;
}

try{
 const data=JSON.parse(localStorage.getItem(KEY)||'[]');
 if(Array.isArray(data))reports=data.filter(valid);
}catch(e){
 alert('保存データを読み込めませんでした。');
}

function save(){
 localStorage.setItem(KEY,JSON.stringify(reports));
}

function nowLocal(){
 const d=new Date();
 return new Date(d.getTime()-d.getTimezoneOffset()*60000)
  .toISOString().slice(0,16);
}

function switchTab(tab){
 document.querySelectorAll('.view').forEach(e=>{
  e.classList.toggle('active',e.id===tab+'View');
 });
 document.querySelectorAll('nav button').forEach(e=>{
  e.classList.toggle('active',e.dataset.tab===tab);
 });
 if(tab==='map')setTimeout(()=>map.invalidateSize(),60);
 render();
}

document.querySelectorAll('nav button').forEach(b=>{
 b.addEventListener('click',()=>switchTab(b.dataset.tab));
});

function inPeriod(r){
 const p=$('period').value;
 if(p==='all')return true;
 const t=new Date(r.foundAt).getTime();
 const now=Date.now();
 if(!Number.isFinite(t))return false;
 if(p==='week')return t>=now-7*86400000&&t<=now;
 return new Date(r.foundAt).toDateString()===
  new Date().toDateString();
}

function card(r){
 return `<article class="entry">
 <h3>${escape(r.shop)}</h3>
 <p><strong>${escape(r.product)}</strong> · ${escape(r.status)}</p>
 <p>${escape(r.foundAt.replace('T',' '))}</p>
 ${r.memo?`<p>${escape(r.memo)}</p>`:''}
 <div class="actions">
 <button data-action="view" data-id="${escape(r.id)}">地図で見る</button>
 <button data-action="edit" data-id="${escape(r.id)}">編集</button>
 <button data-action="delete" data-id="${escape(r.id)}">削除</button>
 </div></article>`;
}

function render(){
 const sorted=[...reports].sort((a,b)=>
  b.foundAt.localeCompare(a.foundAt)
 );
 $('historyList').innerHTML=sorted.length?
  sorted.map(card).join(''):
  '<p class="hint">まだ発見記録がありません。</p>';

 $('mapList').innerHTML=
  sorted.filter(inPeriod).map(card).join('')||
  '<p class="hint">この期間の発見記録はありません。</p>';

 markers.clearLayers();

 sorted.filter(inPeriod).forEach(r=>{
  const marker=L.marker([Number(r.lat),Number(r.lng)])
   .addTo(markers);
  marker.bindPopup(
   `<strong>${escape(r.shop)}</strong>
   <p>${escape(r.product)}</p>
   <small>${escape(r.foundAt.replace('T',' '))} · ${escape(r.status)}</small>`
  );
 });
}

function formFor(r){
 editId=r?.id||null;
 $('formTitle').textContent=editId?
  '発見情報を編集':'発見情報を登録';
 $('shop').value=r?.shop||'';
 $('product').value=r?.product||'';
 $('foundAt').value=r?.foundAt||nowLocal();
 $('status').value=r?.status||'販売を確認';
 $('memo').value=r?.memo||'';
 $('lat').value=r?.lat??'';
 $('lng').value=r?.lng??'';
 $('cancelEdit').hidden=!editId;
 switchTab('add');
}

// ========================================
// 店舗データ管理
// ========================================

function isStore(p){
 return p&&typeof p.name==='string'&&p.name.trim()&&
 Number.isFinite(Number(p.lat))&&
 Number.isFinite(Number(p.lng))&&
 Number(p.lat)>35&&Number(p.lat)<38&&
 Number(p.lng)>138&&Number(p.lng)<141;
}

function norm(s){
 return String(s||'').normalize('NFKC').toLowerCase()
  .replace(/[\s\u3000・ー－-]/g,'');
}

function storeKey(p){
 return norm(p.name)+'|'+
  Number(p.lat).toFixed(6)+'|'+
  Number(p.lng).toFixed(6);
}

function brandNorm(s){
 const n=norm(s);
 if(/^(セブン|seven|7eleven)/.test(n))return 'seven';
 if(/^(ファミマ|ファミリマト|ファミリーマート|familymart)/.test(n))
  return 'familymart';
 if(/^(ロソン|lawson)/.test(n))return 'lawson';
 if(/^(ミニストップ|ministop)/.test(n))return 'ministop';
 return n;
}

function updateCount(){
 $('storeCount').textContent=
  `保存済み店舗 ${stores.length}件（この端末のみ）`;
}

function persistStores(){
 try{
  localStorage.setItem(STORE_KEY,JSON.stringify(stores));
  updateCount();
  return true;
 }catch(e){
  alert('店舗データの保存に失敗しました。容量を確認してください。');
  return false;
 }
}

try{
 const saved=JSON.parse(localStorage.getItem(STORE_KEY)||'[]');
 if(Array.isArray(saved))stores=saved.filter(isStore);
}catch(e){}

function addStores(items){
 const existing=new Set(stores.map(storeKey));
 let count=0;

 items.filter(isStore).forEach(p=>{
  const x={
   name:String(p.name).trim(),
   city:String(p.city||'').trim(),
   lat:Number(p.lat),
   lng:Number(p.lng)
  };

  if(!existing.has(storeKey(x))){
   stores.push(x);
   existing.add(storeKey(x));
   count++;
  }
 });

 persistStores();
 return count;
}

const historyStores=reports.map(r=>({
 name:r.shop,
 city:'',
 lat:Number(r.lat),
 lng:Number(r.lng)
}));
addStores(historyStores);

fetch('./tochigi-convenience-stores.csv')
 .then(response=>{
  if(!response.ok)throw Error('店舗CSVの取得に失敗しました');
  return response.text();
 })
 .then(csv=>{
  const importedStores=parseCSV(csv);
  stores=[];
  addStores(importedStores);
  console.log('最新の栃木県店舗データ:',importedStores.length,'件');
 })
 .catch(error=>{
  console.error('店舗データ読み込みエラー:',error);
 });

function searchStores(){
 const area=norm($('searchArea').value);
 const term=brandNorm($('storeQuery').value);
 const out=$('storeResults');
 out.replaceChildren();

 if(!term){
  out.textContent='店舗名・チェーン名を入力してください。';
  return;
 }

 const matches=stores.filter(p=>{
  const name=norm(p.name);
  const brand=brandNorm(p.name);
  const city=norm(p.city);

  return (
   brand.includes(term)||
   name.includes(term)||
   (term==='familymart'&&name.includes('ファミリマト'))
  )&&(!area||city.includes(area)||name.includes(area));
 });

 const count=document.createElement('p');
 count.className='hint';
 count.textContent=
  `${matches.length}件の店舗が見つかりました（保存済み${stores.length}件から検索）`;
 out.append(count);

 if(!matches.length){
  const msg=document.createElement('p');
  msg.textContent='該当店舗は未登録です。店舗データを確認してください。';
  out.append(msg);
  return;
 }

 matches.forEach(p=>{
  const b=document.createElement('button');
  b.type='button';
  b.className='store-result';

  const title=document.createElement('strong');
  title.textContent=p.name;

  const sub=document.createElement('small');
  sub.textContent=[
   p.city,
   `緯度 ${p.lat.toFixed(5)} / 経度 ${p.lng.toFixed(5)}`
  ].filter(Boolean).join(' · ');

  b.append(title,sub);

  b.addEventListener('click',()=>{
   $('shop').value=p.name;
   $('lat').value=p.lat.toFixed(6);
   $('lng').value=p.lng.toFixed(6);
   out.textContent='選択済み：'+p.name;
   map.setView([p.lat,p.lng],17);
  });

  out.append(b);
 });
}

// ========================================
// チェーン名プルダウン
// ========================================

const chainNames=[
 'セブンイレブン',
 'ファミリーマート',
 'ローソン',
 'ミニストップ'
];

const storeQueryInput=$('storeQuery');
const chainDropdown=document.createElement('div');
chainDropdown.id='chainDropdown';
chainDropdown.hidden=true;
chainDropdown.style.cssText=
 'position:absolute;top:100%;left:0;right:0;z-index:1000;'+
 'background:#fff;border:1px solid #cbd5e1;border-radius:10px;'+
 'box-shadow:0 8px 20px rgba(0,0,0,.15);'+
 'max-height:240px;overflow-y:auto;';

const searchRow=storeQueryInput.closest('.searchrow');
searchRow.style.position='relative';
searchRow.appendChild(chainDropdown);

storeQueryInput.setAttribute('autocomplete','off');
storeQueryInput.setAttribute('aria-controls','chainDropdown');
storeQueryInput.setAttribute('aria-expanded','false');

function closeChainDropdown(){
 chainDropdown.hidden=true;
 storeQueryInput.setAttribute('aria-expanded','false');
}

function showChainDropdown(){
 const q=norm(storeQueryInput.value.trim());
 chainDropdown.replaceChildren();

 const options=chainNames.filter(name=>
  !q||
  norm(name).includes(q)||
  (name==='ファミリーマート'&&norm('ファミマ').includes(q))||
  (name==='セブンイレブン'&&'seveneleven'.includes(q))
 );

 options.forEach(name=>{
  const option=document.createElement('button');
  option.type='button';
  option.textContent=name;
  option.style.cssText=
   'display:block;width:100%;padding:12px 14px;'+
   'text-align:left;background:white;color:#111827;'+
   'border:0;border-bottom:1px solid #e5e7eb;'+
   'cursor:pointer;font-size:16px;';

  option.addEventListener('click',()=>{
   storeQueryInput.value=name;
   closeChainDropdown();
   searchStores();
  });

  chainDropdown.appendChild(option);
 });

 chainDropdown.hidden=options.length===0;
 storeQueryInput.setAttribute('aria-expanded',String(options.length>0));
}

storeQueryInput.addEventListener('focus',showChainDropdown);
storeQueryInput.addEventListener('click',showChainDropdown);
storeQueryInput.addEventListener('input',showChainDropdown);

storeQueryInput.addEventListener('keydown',e=>{
 if(e.key==='Escape')closeChainDropdown();
});

document.addEventListener('pointerdown',e=>{
 if(!searchRow.contains(e.target))closeChainDropdown();
});

$('storeSearch').addEventListener('click',()=>{
 closeChainDropdown();
 searchStores();
});

$('storeQuery').addEventListener('keydown',e=>{
 if(e.key==='Enter'){
  e.preventDefault();
  closeChainDropdown();
  searchStores();
 }
});

$('searchArea').addEventListener('keydown',e=>{
 if(e.key==='Enter'){
  e.preventDefault();
  searchStores();
 }
});

$('storeRemember').addEventListener('click',()=>{
 const name=$('shop').value.trim();
 const lat=$('lat').value;
 const lng=$('lng').value;

 const p={
  name,
  city:$('searchArea').value.trim(),
  lat:Number(lat),
  lng:Number(lng)
 };

 if(!name||lat===''||lng===''||!isStore(p)){
  alert('栃木県内の正確な店舗名・緯度・経度を入力してください。');
  return;
 }

 const n=addStores([p]);
 alert(n?'店舗一覧に保存しました。':'すでに登録されている店舗です。');
});

function csvEscape(x){
 const s=String(x??'');
 return /[",\r\n]/.test(s)?
  '"'+s.replace(/"/g,'""')+'"':s;
}

$('storeExport').addEventListener('click',()=>{
 const lines=[
  'name,city,lat,lng',
  ...stores.map(p=>[p.name,p.city,p.lat,p.lng].map(csvEscape).join(','))
 ];

 const blob=new Blob(
  ['\uFEFF'+lines.join('\r\n')],
  {type:'text/csv;charset=utf-8'}
 );

 const a=document.createElement('a');
 a.href=URL.createObjectURL(blob);
 a.download='pokeca-tochigi-stores.csv';
 a.click();
 setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});

function parseCSV(src){
 const rows=[];
 let row=[];
 let field='';
 let quoted=false;

 src=src.replace(/^\uFEFF/,'');

 for(let i=0;i<src.length;i++){
  const ch=src[i];

  if(ch==='"'){
   if(quoted&&src[i+1]==='"'){
    field+='"';
    i++;
   }else{
    quoted=!quoted;
   }
  }else if(ch===','&&!quoted){
   row.push(field);
   field='';
  }else if((ch==='\n'||ch==='\r')&&!quoted){
   if(ch==='\r'&&src[i+1]==='\n')i++;
   row.push(field);
   if(row.some(x=>x.trim()))rows.push([...row]);
   row=[];
   field='';
  }else{
   field+=ch;
  }
 }

 row.push(field);
 if(row.some(x=>x.trim()))rows.push(row);
 if(!rows.length)return [];

 const headers=rows.shift().map(x=>x.trim().toLowerCase());

 for(const h of ['name','city','lat','lng']){
  if(!headers.includes(h)){
   throw Error('CSVの見出しは name,city,lat,lng が必要です。');
  }
 }

 return rows.map(r=>
  Object.fromEntries(headers.map((h,i)=>[h,r[i]||'']))
 );
}

$('storeImport').addEventListener('change',async e=>{
 const f=e.target.files?.[0];
 if(!f)return;

 try{
  if(f.size>2000000)throw Error('CSVは2MB以下にしてください。');

  const rows=parseCSV(await f.text());
  if(rows.length>10000)throw Error('一度に取り込めるのは1万件までです。');

  const validRows=rows.filter(isStore);
  if(!validRows.length){
   throw Error('栃木県内の有効な店舗データがありません。');
  }

  if(confirm(`${validRows.length}件の店舗データを取り込みますか？`)){
   const n=addStores(validRows);
   alert(`${n}件を追加しました（重複は除外）。`);
  }
 }catch(err){
  alert('CSV取込エラー：'+err.message);
 }

 e.target.value='';
});

// ========================================
// 商品名プルダウン検索
// ひらがな・カタカナ両対応
// ========================================

const packInput=$('product');

const packDropdown=document.createElement('div');
packDropdown.id='packDropdown';
packDropdown.hidden=true;
packDropdown.style.cssText=
 'position:absolute;top:100%;left:0;right:0;z-index:1100;'+
 'background:#fff;border:1px solid #cbd5e1;border-radius:10px;'+
 'box-shadow:0 8px 20px rgba(0,0,0,.15);'+
 'max-height:280px;overflow-y:auto;';

const packWrap=document.createElement('div');
packWrap.style.cssText='position:relative;width:100%;';

packInput.parentNode.insertBefore(packWrap,packInput);
packWrap.append(packInput,packDropdown);

packInput.setAttribute('autocomplete','off');
packInput.setAttribute('placeholder','商品名・省略名で検索');
packInput.setAttribute('aria-controls','packDropdown');
packInput.setAttribute('aria-expanded','false');

const packAliases={
 'MEGAドリームex':['メガドリ','メガドリーム'],
 'VSTARユニバース':['vユニ','ブイユニ'],
 'シャイニートレジャーex':['シャイトレ','シャイニ'],
 'シャイニースターV':['シャイスタ'],
 'ポケモンカード151（イチゴーイチ）':['151','イチゴーイチ'],
 'ポケモンカード151':['151','イチゴーイチ'],
 '黒炎の支配者':['黒炎'],
 'ロケット団の栄光':['ロケ団','ロケット団'],
 'テラスタルフェスex':['テラフェス'],
 '30th CELEBRATION':['30周年'],
 '25th ANNIVERSARY COLLECTION':['25周年'],
 'バトルパートナーズ':['バトパ'],
 '超電ブレイカー':['超電'],
 '楽園ドラゴーナ':['楽ドラ'],
 '熱風のアリーナ':['熱風'],
 'インフェルノX':['インフェ'],
 'メガブレイブ':['メガブレ'],
 'メガシンフォニア':['メガシン'],
 'ホワイトフレア':['ホワフレ'],
 'ブラックボルト':['ブラボル']
};

// ★変更点：カタカナをひらがなに統一
function packNorm(s){
 return String(s||'')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\u30A1-\u30F6]/g,c=>
   String.fromCharCode(c.charCodeAt(0)-0x60)
  )
  .replace(/[\s\u3000・ー－‐-‒–—―_()（）「」『』]/g,'');
}

function closePackDropdown(){
 packDropdown.hidden=true;
 packInput.setAttribute('aria-expanded','false');
}

function showPackDropdown(){
 const q=packNorm(packInput.value);
 packDropdown.replaceChildren();

 if(!packs.length){
  const message=document.createElement('p');
  message.className='hint';
  message.style.padding='12px';
  message.textContent=
   '商品データを読み込み中、またはCSVを取得できません。';
  packDropdown.append(message);
  packDropdown.hidden=false;
  return;
 }

 // 商品名の部分一致 + 省略名の部分一致
 // 両方ともひらがな・カタカナを統一して比較
 const matches=packs.filter(p=>
  !q||
  packNorm(p.name).includes(q)||
  Object.entries(packAliases).some(([key,aliases])=>
   packNorm(p.name).includes(packNorm(key))&&
   aliases.some(alias=>packNorm(alias).includes(q))
  )
 );

 if(!matches.length){
  const message=document.createElement('p');
  message.className='hint';
  message.style.padding='12px';
  message.textContent=
   '該当する商品がありません。手入力も可能です。';
  packDropdown.append(message);
 }

 matches.forEach(p=>{
  const button=document.createElement('button');
  button.type='button';
  button.style.cssText=
   'display:block;width:100%;padding:10px 12px;'+
   'text-align:left;background:#fff;color:#111827;'+
   'border:0;border-bottom:1px solid #e5e7eb;cursor:pointer;';

  const name=document.createElement('strong');
  name.textContent=p.name;

  const detail=document.createElement('small');
  detail.style.cssText=
   'display:block;color:#64748b;margin-top:3px;';

  detail.textContent=[
   p.date,
   p.price?p.price+'円':'',
   p.tax
  ].filter(Boolean).join(' · ');

  button.append(name,detail);

  button.addEventListener('click',()=>{
   packInput.value=p.name;
   closePackDropdown();
  });

  packDropdown.append(button);
 });

 packDropdown.hidden=false;
 packInput.setAttribute('aria-expanded','true');
}

packInput.addEventListener('focus',showPackDropdown);
packInput.addEventListener('click',showPackDropdown);

// 1文字入力・削除するたびに検索
packInput.addEventListener('input',showPackDropdown);

packInput.addEventListener('keydown',e=>{
 if(e.key==='Escape')closePackDropdown();
});

document.addEventListener('pointerdown',e=>{
 if(!packWrap.contains(e.target))closePackDropdown();
});

function parsePackCSV(src){
 const rows=[];
 let row=[];
 let field='';
 let quoted=false;

 src=src.replace(/^\uFEFF/,'');

 for(let i=0;i<src.length;i++){
  const ch=src[i];

  if(ch==='"'){
   if(quoted&&src[i+1]==='"'){
    field+='"';
    i++;
   }else{
    quoted=!quoted;
   }
  }else if(ch===','&&!quoted){
   row.push(field);
   field='';
  }else if((ch==='\n'||ch==='\r')&&!quoted){
   if(ch==='\r'&&src[i+1]==='\n')i++;
   row.push(field);
   if(row.some(x=>x.trim()))rows.push([...row]);
   row=[];
   field='';
  }else{
   field+=ch;
  }
 }

 row.push(field);
 if(row.some(x=>x.trim()))rows.push(row);
 if(!rows.length)return [];

 const headers=rows.shift().map(h=>h.trim());

 if(!headers.includes('パック名')||
    !headers.includes('発売日')){
  throw Error('商品CSVの列名を確認してください。');
 }

 return rows.map(r=>
  Object.fromEntries(headers.map((h,i)=>[h,r[i]||'']))
 );
}

function packDateValue(s){
 const m=String(s).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
 if(!m)return 0;

 return Number(m[1])*10000+
  Number(m[2])*100+
  Number(m[3]);
}

fetch('./pokemon_packs.csv')
 .then(response=>{
  if(!response.ok)throw Error('商品CSVを取得できません');
  return response.text();
 })
 .then(csv=>{
  packs=parsePackCSV(csv)
   .map(r=>({
    name:String(r['パック名']||'').trim(),
    date:String(r['発売日']||'').trim(),
    price:String(r['希望小売価格（円）']||'').trim(),
    tax:String(r['価格表記']||'').trim()
   }))
   .filter(p=>p.name&&packDateValue(p.date)>0)
   .sort((a,b)=>
    packDateValue(b.date)-packDateValue(a.date)
   );

  console.log('商品CSV読み込み:',packs.length,'件');

  if(document.activeElement===packInput){
   showPackDropdown();
  }
 })
 .catch(error=>{
  console.error('商品CSV読み込みエラー:',error);

  if(document.activeElement===packInput){
   showPackDropdown();
  }
 });

updateCount();

// ========================================
// 発見履歴の操作
// ========================================

function handleCard(e){
 const b=e.target.closest('button[data-action]');
 if(!b)return;

 const r=reports.find(x=>x.id===b.dataset.id);
 if(!r)return;

 if(b.dataset.action==='delete'){
  if(confirm('この発見記録を削除しますか？')){
   reports=reports.filter(x=>x.id!==r.id);
   save();
   render();
  }
 }else if(b.dataset.action==='edit'){
  formFor(r);
 }else{
  switchTab('map');
  $('period').value='all';
  render();
  map.setView([r.lat,r.lng],16);

  markers.eachLayer(m=>{
   if(m.getLatLng().lat===Number(r.lat)&&
      m.getLatLng().lng===Number(r.lng)){
    m.openPopup();
   }
  });
 }
}

$('historyList').addEventListener('click',handleCard);
$('mapList').addEventListener('click',handleCard);
$('period').addEventListener('change',render);

$('reportForm').addEventListener('submit',e=>{
 e.preventDefault();

 const lat=Number($('lat').value);
 const lng=Number($('lng').value);

 if(!Number.isFinite(lat)||!Number.isFinite(lng)||
    Math.abs(lat)>90||Math.abs(lng)>180){
  alert('緯度・経度を確認してください');
  return;
 }

 const r={
  id:editId||((crypto.randomUUID&&crypto.randomUUID())||String(Date.now())),
  shop:$('shop').value.trim(),
  product:$('product').value.trim(),
  foundAt:$('foundAt').value,
  status:$('status').value,
  memo:$('memo').value.trim(),
  lat,
  lng
 };

 if(!r.shop||!r.product||!r.foundAt)return;

 if(editId){
  reports=reports.map(x=>x.id===editId?r:x);
 }else{
  reports.push(r);
 }

 try{
  save();
 }catch(err){
  alert('保存容量が不足している可能性があります');
  return;
 }

 formFor(null);
 switchTab('map');
 $('period').value='all';
 render();
 map.setView([lat,lng],16);
});

$('cancelEdit').addEventListener('click',()=>formFor(null));

// ========================================
// 地図
// ========================================

map=L.map('map').setView([36.5551,139.8828],12);

L.tileLayer(
 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
 {
  maxZoom:19,
  attribution:'&copy; OpenStreetMap contributors'
 }
).addTo(map);

markers=L.layerGroup().addTo(map);

let pressTimer;

const start=e=>{
 clearTimeout(pressTimer);
 const point=e.latlng;

 pressTimer=setTimeout(()=>{
  formFor(null);
  $('lat').value=point.lat.toFixed(6);
  $('lng').value=point.lng.toFixed(6);
 },650);
};

map.on('mousedown touchstart',start);

map.on('mouseup touchend dragstart move',()=>{
 clearTimeout(pressTimer);
});

map.on('contextmenu',e=>{
 formFor(null);
 $('lat').value=e.latlng.lat.toFixed(6);
 $('lng').value=e.latlng.lng.toFixed(6);
});

$('locate').addEventListener('click',()=>{
 if(!navigator.geolocation){
  alert('位置情報に対応していません');
  return;
 }

 navigator.geolocation.getCurrentPosition(
  p=>map.setView([p.coords.latitude,p.coords.longitude],15),
  ()=>alert('位置情報を取得できませんでした。位置情報設定をご確認ください。'),
  {enableHighAccuracy:true,timeout:10000}
 );
});

// ========================================
// 発見履歴のエクスポート・インポート
// ========================================

$('export').addEventListener('click',()=>{
 const blob=new Blob(
  [JSON.stringify(reports,null,2)],
  {type:'application/json'}
 );

 const a=document.createElement('a');
 a.href=URL.createObjectURL(blob);
 a.download='pokeca-reports.json';
 a.click();
 setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});

$('import').addEventListener('change',async e=>{
 const file=e.target.files?.[0];
 if(!file)return;

 try{
  const data=JSON.parse(await file.text());

  if(!Array.isArray(data)||
     !data.every(valid)||
     data.length>10000){
   throw Error('invalid');
  }

  if(confirm(`${data.length}件の記録で現在のデータを置き換えますか？`)){
   reports=data;
   save();
   render();
  }
 }catch(err){
  alert('読み込めないJSONファイルです');
 }

 e.target.value='';
});

formFor(null);
switchTab('map');

})();
