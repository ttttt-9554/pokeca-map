(()=>{
'use strict';

const KEY='pokeca-reports-v1';
const STORE_KEY='pokeca-tochigi-stores-v05';
const $=id=>document.getElementById(id);

let reports=[];
let stores=[];
let packs=[];
let decks=[];
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
 <p><strong>${escape(r.product)}</strong> · ${escape(r.status)} · ${r.category==='deck'?'構築デッキ':'拡張パック'}</p>
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
 $('mapList').innerHTML=sorted.filter(inPeriod).map(card).join('')||
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
 productCategory.value=r?.category==='deck'?'deck':'pack';
 closePackDropdown();
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
  msg.textContent='該当店舗は未登録です
