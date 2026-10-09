(()=>{'use strict';const KEY='pokeca-reports-v1';const $=id=>document.getElementById(id);let reports=[];try{const data=JSON.parse(localStorage.getItem(KEY)||'[]');if(Array.isArray(data))reports=data.filter(valid)}catch(e){alert('保存データを読み込めませんでした。')}let editId=null;let map,markers;const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function valid(r){return r&&typeof r.id==='string'&&typeof r.shop==='string'&&typeof r.product==='string'&&typeof r.foundAt==='string'&&Number.isFinite(Number(r.lat))&&Math.abs(Number(r.lat))<=90&&Number.isFinite(Number(r.lng))&&Math.abs(Number(r.lng))<=180}function save(){localStorage.setItem(KEY,JSON.stringify(reports))}function nowLocal(){const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}function switchTab(tab){document.querySelectorAll('.view').forEach(e=>e.classList.toggle('active',e.id===tab+'View'));document.querySelectorAll('nav button').forEach(e=>e.classList.toggle('active',e.dataset.tab===tab));if(tab==='map')setTimeout(()=>map.invalidateSize(),60);render()}document.querySelectorAll('nav button').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));function inPeriod(r){const p=$('period').value;if(p==='all')return true;const t=new Date(r.foundAt).getTime(),now=Date.now();if(!Number.isFinite(t))return false;if(p==='week')return t>=now-7*86400000&&t<=now;return new Date(r.foundAt).toDateString()===new Date().toDateString()}function card(r){return `<article class="entry"><h3>${escape(r.shop)}</h3><p><strong>${escape(r.product)}</strong> · ${escape(r.status)}</p><p>${escape(r.foundAt.replace('T',' '))}</p>${r.memo?`<p>${escape(r.memo)}</p>`:''}<div class="actions"><button data-action="view" data-id="${escape(r.id)}">地図で見る</button><button data-action="edit" data-id="${escape(r.id)}">編集</button><button data-action="delete" data-id="${escape(r.id)}">削除</button></div></article>`}function render(){const sorted=[...reports].sort((a,b)=>b.foundAt.localeCompare(a.foundAt));$('historyList').innerHTML=sorted.length?sorted.map(card).join(''):'<p class="hint">まだ発見記録がありません。</p>';$('mapList').innerHTML=sorted.filter(inPeriod).map(card).join('')||'<p class="hint">この期間の発見記録はありません。</p>';markers.clearLayers();sorted.filter(inPeriod).forEach(r=>{const marker=L.marker([Number(r.lat),Number(r.lng)]).addTo(markers);marker.bindPopup(`<strong>${escape(r.shop)}</strong><p>${escape(r.product)}</p><small>${escape(r.foundAt.replace('T',' '))} · ${escape(r.status)}</small>`);});}function formFor(r){editId=r?.id||null;$('formTitle').textContent=editId?'発見情報を編集':'発見情報を登録';$('shop').value=r?.shop||'';$('product').value=r?.product||'';$('foundAt').value=r?.foundAt||nowLocal();$('status').value=r?.status||'販売を確認';$('memo').value=r?.memo||'';$('lat').value=r?.lat??'';$('lng').value=r?.lng??'';$('cancelEdit').hidden=!editId;switchTab('add')}
let searchController=null;
const normalizeName=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s\u3000・ー－-]/g,'');
function queryAliases(s){
 const n=normalizeName(s);
 if(/セブン|7eleven|seveneleven/.test(n))return ['セブン','7-Eleven','セブン-イレブン'];
 if(/ファミマ|ファミリーマート/.test(n))return ['ファミリーマート','FamilyMart'];
 if(/ローソン|lawson/.test(n))return ['ローソン','Lawson'];
 if(/ミニストップ|ministop/.test(n))return ['ミニストップ','Ministop'];
 return [s.trim()];
}
function showStores(items){
 const out=$('storeResults');out.replaceChildren();
 if(!items.length){out.textContent='この周辺に一致する店舗が見つかりません。地域を変えるか、地図の長押しで登録できます。';return;}
 const count=document.createElement('p');count.className='hint';count.textContent=`候補 ${items.length} 件（地図データに登録された店舗のみ）`;out.append(count);
 items.forEach(p=>{
  const b=document.createElement('button');b.type='button';b.className='store-result';
  const title=document.createElement('strong');title.textContent=p.name;
  const sub=document.createElement('small');sub.textContent=[p['addr:city'],p['addr:street'],p['addr:housenumber']].filter(Boolean).join(' ')||`緯度 ${p.lat.toFixed(5)}・経度 ${p.lon.toFixed(5)}`;
  b.append(title,sub);b.addEventListener('click',()=>{
   $('shop').value=p.name;$('lat').value=p.lat.toFixed(6);$('lng').value=p.lon.toFixed(6);
   out.textContent='選択済み：'+p.name;map.setView([p.lat,p.lon],17);
  });out.append(b);
 });
}
async function searchStores(){
 const area=$('searchArea').value.trim(),term=$('storeQuery').value.trim(),out=$('storeResults');
 if(area.length<2||term.length<2){out.textContent='地域と店舗名をそれぞれ2文字以上入力してください。';return;}
 if(searchController)searchController.abort();
 const controller=new AbortController();searchController=controller;
 $('storeSearch').disabled=true;out.textContent='地域を確認しています…';
 try{
  const url=new URL('https://photon.komoot.io/api/');url.searchParams.set('q',area);url.searchParams.set('limit','8');
  const geo=await fetch(url,{signal:controller.signal});if(!geo.ok)throw Error('地名検索が混雑しています');
  const places=(await geo.json()).features||[];
  const jp=places.find(f=>{const c=f.geometry?.coordinates||[],p=f.properties||{};return c.length===2&&(p.countrycode?.toUpperCase()==='JP'||p.country==='Japan'||(c[0]>122&&c[0]<154&&c[1]>20&&c[1]<46.5));});
  if(!jp){out.textContent='地域が見つかりません。市区町村や駅名を入力してください。';return;}
  const [lon,lat]=jp.geometry.coordinates;
  out.textContent='周辺の店舗を探しています（数秒かかる場合があります）…';
  const radius=5000;
  // 地域の近くの店舗に限定して、公共Overpass APIへの負荷を抑える。
  const query=`[out:json][timeout:20];(nwr(around:${radius},${lat},${lon})[shop~"^(convenience|supermarket|department_store|mall|books|toys|gift)$"];nwr(around:${radius},${lat},${lon})[name][shop="cards"];);out center tags;`;
  // 公開OverpassインスタンスにGETで接続。POSTがSafariやサーバーに拒否される問題を回避。
  const endpoints=['https://overpass.private.coffee/api/interpreter','https://overpass.nchc.org.tw/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
  let data=null, lastError='';
  for(const endpoint of endpoints){
   try{
    out.textContent='店舗検索中…（接続先を確認しています）';
    const response=await fetch(endpoint+'?data='+encodeURIComponent(query),{method:'GET',signal:controller.signal});
    if(!response.ok)throw Error('HTTP '+response.status);
    const result=await response.json();
    if(!Array.isArray(result.elements))throw Error('応答形式が不正');
    data=result;break;
   }catch(err){if(err.name==='AbortError')throw err;lastError=err.message||String(err);}
  }
  if(!data)throw Error('公開店舗検索サービスに接続できません（'+lastError+'）');
  const aliases=queryAliases(term).map(normalizeName);
  const found=(data.elements||[]).map(e=>{
   const tags=e.tags||{},la=e.lat??e.center?.lat,lo=e.lon??e.center?.lon;
   return {...tags,lat:la,lon:lo};
  }).filter(p=>p.name&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&aliases.some(a=>normalizeName(p.name+' '+(p.brand||'')+' '+(p.operator||'')).includes(a)));
  const unique=[...new Map(found.map(p=>[`${p.name}:${p.lat.toFixed(5)}:${p.lon.toFixed(5)}`,p])).values()].slice(0,40);
  showStores(unique);
 }catch(e){if(e.name!=='AbortError')out.textContent='検索に失敗しました：'+(e.message||'通信エラー')+'。地図の長押しで手動登録もできます。';}
 finally{if(searchController===controller)$('storeSearch').disabled=false;}
}
$('storeSearch').addEventListener('click',searchStores);
$('storeQuery').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchStores();}});
$('searchArea').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchStores();}});
function handleCard(e){const b=e.target.closest('button[data-action]');if(!b)return;const r=reports.find(x=>x.id===b.dataset.id);if(!r)return;if(b.dataset.action==='delete'){if(confirm('この発見記録を削除しますか？')){reports=reports.filter(x=>x.id!==r.id);save();render()}}else if(b.dataset.action==='edit')formFor(r);else{switchTab('map');$('period').value='all';render();map.setView([r.lat,r.lng],16);markers.eachLayer(m=>{if(m.getLatLng().lat===Number(r.lat)&&m.getLatLng().lng===Number(r.lng))m.openPopup()})}}$('historyList').addEventListener('click',handleCard);$('mapList').addEventListener('click',handleCard);$('period').addEventListener('change',render);$('reportForm').addEventListener('submit',e=>{e.preventDefault();const lat=Number($('lat').value),lng=Number($('lng').value);if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180){alert('緯度・経度を確認してください');return}const r={id:editId||((crypto.randomUUID&&crypto.randomUUID())||String(Date.now())),shop:$('shop').value.trim(),product:$('product').value.trim(),foundAt:$('foundAt').value,status:$('status').value,memo:$('memo').value.trim(),lat,lng};if(!r.shop||!r.product||!r.foundAt)return;if(editId)reports=reports.map(x=>x.id===editId?r:x);else reports.push(r);try{save()}catch(err){alert('保存容量が不足している可能性があります');return}formFor(null);switchTab('map');$('period').value='all';render();map.setView([lat,lng],16)});$('cancelEdit').addEventListener('click',()=>formFor(null));map=L.map('map').setView([36.5551,139.8828],12);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);markers=L.layerGroup().addTo(map);let pressTimer;const start=e=>{clearTimeout(pressTimer);const point=e.latlng;pressTimer=setTimeout(()=>{formFor(null);$('lat').value=point.lat.toFixed(6);$('lng').value=point.lng.toFixed(6)},650)};map.on('mousedown touchstart',start);map.on('mouseup touchend dragstart move',()=>clearTimeout(pressTimer));map.on('contextmenu',e=>{formFor(null);$('lat').value=e.latlng.lat.toFixed(6);$('lng').value=e.latlng.lng.toFixed(6)});$('locate').addEventListener('click',()=>{if(!navigator.geolocation){alert('位置情報に対応していません');return}navigator.geolocation.getCurrentPosition(p=>map.setView([p.coords.latitude,p.coords.longitude],15),()=>alert('位置情報を取得できませんでした。Safariの位置情報設定をご確認ください。'),{enableHighAccuracy:true,timeout:10000})});$('export').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(reports,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='pokeca-reports.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)});$('import').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{const data=JSON.parse(await file.text());if(!Array.isArray(data)||!data.every(valid)||data.length>10000)throw Error('invalid');if(confirm(`${data.length}件の記録で現在のデータを置き換えますか？`)){reports=data;save();render()}}catch(err){alert('読み込めないJSONファイルです')}e.target.value=''});formFor(null);switchTab('map')})();
