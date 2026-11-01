/* Toreca Radar - Information Plaza / private store sales formats v1 */
(function(){
  'use strict';
  const TABLE='info_plaza_store_sales';
  const PREFECTURES=[
    '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
    '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
    '新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県',
    '静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県',
    '奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県',
    '徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県',
    '熊本県','大分県','宮崎県','鹿児島県','沖縄県'
  ];
  const SELECT='id,store_name,store_key,prefecture,genre,shrink_state,peri_state,tape_cut_state,notes,updated_at';
  const $=id=>document.getElementById(id);
  const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[ch]);
  const normalize=value=>String(value??'').normalize('NFKC')
    .toLocaleLowerCase('ja-JP').replace(/[\s　・･._－（）()【】「」-]+/g,'');
  const formatValue=value=>value==='yes'?'あり':value==='no'?'なし':'未確認';

  let options=null,initialized=false,active=false,authorized=false;
  let rows=[],loaded=false,loading=false,saveBusy=false,editingId='';
  let masterBusy=false,masterLoaded=false,masterChoices=new Map();
  let matchingMasterChoices=[],masterSuggestionIndex=-1,masterSuggestionsOpen=false;
  let storeNameComposing=false;
  let generation=0;

  function client(){return options?.getClient?.()||null;}
  function canAccess(){return !!options?.isDev?.()&&!!options?.getUserId?.()&&!!client();}
  function message(value,isError=false){
    const node=$('infoSalesMessage');
    if(node){
      node.textContent=value||'';
      node.dataset.error=isError?'true':'false';
    }
  }
  function mount(){
    const container=$('infoPlazaContent');
    if(!container||initialized)return;
    initialized=true;
    container.innerHTML=
      '<section id="infoSalesAdmin" class="info-sales-admin" hidden>'+
        '<h3>🏬 店舗別販売形態 <small>開発者専用</small></h3>'+
        '<p class="info-sales-description">店舗ごとの販売時の状態を記録します。ポケカはシュリンク・ペリ、ワンピースはテプカ（テープカット）。「未確認」は「なし」と区別します。</p>'+
        '<form id="infoSalesForm" autocomplete="off">'+
          '<h4 id="infoSalesFormHeading">新規登録</h4>'+
          '<label for="infoSalesStore">店舗名</label>'+
          '<div id="infoSalesStorePicker" class="info-sales-store-picker">'+
            '<div class="info-sales-store-row">'+
              '<input type="search" id="infoSalesStore" maxlength="160" required autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" placeholder="店舗名で検索・候補を選択" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="infoSalesStoreSuggestions">'+
              '<button type="button" id="infoSalesStoreToggle" class="info-sales-store-toggle" aria-label="店舗の候補一覧を表示" aria-controls="infoSalesStoreSuggestions" aria-expanded="false">⌄</button>'+
            '</div>'+
            '<div id="infoSalesStoreSuggestions" class="info-sales-store-suggestions" role="listbox" aria-label="店舗マスターの候補" hidden></div>'+
          '</div>'+
          '<p id="infoSalesMasterHint" class="info-sales-hint">店舗マスターを読み込みます。候補にない店舗も直接入力できます。</p>'+
          '<div class="info-sales-form-grid">'+
            '<label>都道府県<select id="infoSalesPrefecture" required><option value="">選択してください</option>'+
              PREFECTURES.map(p=>'<option value="'+escape(p)+'">'+escape(p)+'</option>').join('')+
            '</select></label>'+
            '<label>カードの種類<select id="infoSalesGenre" required>'+
              '<option value="pokemon">ポケカ</option><option value="onepiece">ワンピース</option>'+
            '</select></label>'+
          '</div>'+
          '<div id="infoSalesPokemon" class="info-sales-status-group">'+
            '<label>シュリンク<select id="infoSalesShrink">'+
              '<option value="unknown">未確認</option><option value="yes">あり</option><option value="no">なし</option>'+
            '</select></label>'+
            '<label>ペリ（ペリペリ）<select id="infoSalesPeri">'+
              '<option value="unknown">未確認</option><option value="yes">あり</option><option value="no">なし</option>'+
            '</select></label>'+
          '</div>'+
          '<div id="infoSalesOnepiece" class="info-sales-status-group" hidden>'+
            '<label>テプカ（テープカット）<select id="infoSalesTape">'+
              '<option value="unknown">未確認</option><option value="yes">あり</option><option value="no">なし</option>'+
            '</select></label>'+
          '</div>'+
          '<label for="infoSalesNotes">補足メモ（任意・500文字以内）</label>'+
          '<textarea id="infoSalesNotes" rows="3" maxlength="500" placeholder="購入時の取扱いなど"></textarea>'+
          '<div class="info-sales-form-actions">'+
            '<button type="submit" class="info-sales-save" id="infoSalesSave">保存する</button>'+
            '<button type="button" id="infoSalesReset">入力をクリア</button>'+
          '</div>'+
        '</form>'+
        '<p id="infoSalesMessage" class="info-sales-message" role="status" aria-live="polite"></p>'+
        '<div class="info-sales-list-heading">'+
          '<h4>登録済み店舗 <span id="infoSalesCount">0件</span></h4>'+
          '<button type="button" id="infoSalesReload">再読み込み</button>'+
        '</div>'+
        '<div class="info-sales-filters">'+
          '<input id="infoSalesSearch" type="search" placeholder="店舗名・都道府県・メモで検索" aria-label="販売形態の登録済み店舗を検索">'+
          '<select id="infoSalesFilterGenre" aria-label="カード種類で絞り込み">'+
            '<option value="all">すべて</option><option value="pokemon">ポケカ</option>'+
            '<option value="onepiece">ワンピース</option>'+
          '</select>'+
        '</div>'+
        '<p id="infoSalesListStatus" class="info-sales-hint" role="status" aria-live="polite"></p>'+
        '<div id="infoSalesList" class="info-sales-list"></div>'+
      '</section>';
    $('infoSalesGenre').addEventListener('change',updateGenre);
    const storeInput=$('infoSalesStore');
    storeInput.addEventListener('focus',()=>renderStoreSuggestions(true));
    storeInput.addEventListener('input',()=>{if(!storeNameComposing)renderStoreSuggestions(true);});
    storeInput.addEventListener('compositionstart',()=>{storeNameComposing=true;});
    storeInput.addEventListener('compositionend',()=>{storeNameComposing=false;renderStoreSuggestions(true);});
    storeInput.addEventListener('keydown',handleStoreSuggestionKeydown);
    $('infoSalesStoreToggle').addEventListener('click',()=>{
      if(masterSuggestionsOpen)hideStoreSuggestions();
      else renderStoreSuggestions(true);
    });
    $('infoSalesStoreSuggestions').addEventListener('click',event=>{
      const button=event.target.closest('button[data-info-master-index]');
      if(!button||!event.currentTarget.contains(button))return;
      chooseMasterSuggestion(Number(button.dataset.infoMasterIndex));
    });
    document.addEventListener('pointerdown',event=>{
      if(!event.target.closest('#infoSalesStorePicker'))hideStoreSuggestions();
    });
    $('infoSalesForm').addEventListener('submit',save);
    $('infoSalesReset').addEventListener('click',()=>{resetForm();message('');});
    $('infoSalesSearch').addEventListener('input',renderList);
    $('infoSalesFilterGenre').addEventListener('change',renderList);
    $('infoSalesReload').addEventListener('click',async()=>{
      await Promise.all([refresh(true),refreshMaster(true)]);
    });
    $('infoSalesList').addEventListener('click',onListClick);
    updateGenre();
  }
  function hideStoreSuggestions(){
    masterSuggestionsOpen=false;
    masterSuggestionIndex=-1;
    const dropdown=$('infoSalesStoreSuggestions'),input=$('infoSalesStore'),toggle=$('infoSalesStoreToggle');
    if(dropdown)dropdown.hidden=true;
    if(input)input.setAttribute('aria-expanded','false');
    if(toggle)toggle.setAttribute('aria-expanded','false');
  }
  function renderStoreSuggestions(open=false){
    const dropdown=$('infoSalesStoreSuggestions'),input=$('infoSalesStore'),toggle=$('infoSalesStoreToggle');
    if(!dropdown||!input||!authorized||!canAccess()){hideStoreSuggestions();return;}
    if(!open&&!masterSuggestionsOpen)return;
    const term=normalize(input.value);
    const all=[...masterChoices.entries()].filter(([label,row])=>
      !term||normalize(label+' '+row.name+' '+row.prefecture).includes(term));
    // Prefer a matching store name to a prefecture-only match.
    if(term)all.sort((a,b)=>{
      const rank=([,row])=>normalize(row.name).startsWith(term)?0:
        normalize(row.name).includes(term)?1:2;
      return rank(a)-rank(b)||a[0].localeCompare(b[0],'ja');
    });
    matchingMasterChoices=all.slice(0,40);
    masterSuggestionIndex=-1;
    const count=all.length;
    const buttons=matchingMasterChoices.map(([label,row],index)=>
      '<button type="button" class="info-sales-suggestion" role="option" aria-selected="false" data-info-master-index="'+index+'">'+
        '<span class="info-sales-suggestion-name">'+escape(row.name)+'</span>'+
        '<span class="info-sales-suggestion-pref">'+escape(row.prefecture)+'</span>'+
      '</button>').join('');
    dropdown.innerHTML='<div class="info-sales-suggestion-count">'+
      (masterLoaded?count+'件の候補'+(count>40?'（先頭40件）':''):
        masterBusy?'店舗マスターを読み込み中…':'店舗マスターを取得できませんでした')+
      '</div>'+
      (buttons||'<p class="info-sales-suggestion-empty">'+
        (masterLoaded?'一致する店舗はありません。直接入力して登録できます。':'店舗名を直接入力できます。')+
      '</p>');
    dropdown.hidden=false;
    masterSuggestionsOpen=true;
    input.setAttribute('aria-expanded','true');
    if(toggle)toggle.setAttribute('aria-expanded','true');
  }
  function selectMasterSuggestion(index){
    const pair=matchingMasterChoices[index];
    if(!pair)return;
    const [,row]=pair;
    $('infoSalesStore').value=row.name;
    $('infoSalesPrefecture').value=PREFECTURES.includes(row.prefecture)?row.prefecture:'';
    $('infoSalesMasterHint').textContent='店舗マスターから「'+row.name+'（'+row.prefecture+'）」を選択しました。';
    hideStoreSuggestions();
    $('infoSalesStore').blur();
  }
  function chooseMasterSuggestion(index){selectMasterSuggestion(index);}
  function handleStoreSuggestionKeydown(event){
    if(!masterSuggestionsOpen||storeNameComposing||event.isComposing||event.keyCode===229)return;
    if(event.key==='Escape'){event.preventDefault();hideStoreSuggestions();return;}
    if(!matchingMasterChoices.length)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      const step=event.key==='ArrowDown'?1:-1;
      masterSuggestionIndex=(masterSuggestionIndex+step+matchingMasterChoices.length)%matchingMasterChoices.length;
      const buttons=$('infoSalesStoreSuggestions').querySelectorAll('button[data-info-master-index]');
      buttons.forEach((button,index)=>{
        const selected=index===masterSuggestionIndex;
        button.setAttribute('aria-selected',String(selected));
        button.classList.toggle('is-active',selected);
        if(selected)button.scrollIntoView({block:'nearest'});
      });
    }else if(event.key==='Enter'){
      event.preventDefault();
      selectMasterSuggestion(masterSuggestionIndex<0?0:masterSuggestionIndex);
    }
  }

  function updateGenre(){
    const isPokemon=$('infoSalesGenre')?.value!=='onepiece';
    if($('infoSalesPokemon'))$('infoSalesPokemon').hidden=!isPokemon;
    if($('infoSalesOnepiece'))$('infoSalesOnepiece').hidden=isPokemon;
  }
  function selectMasterIfExact(){
    const input=$('infoSalesStore');
    const row=masterChoices.get(input.value.trim());
    if(!row)return;
    input.value=row.name;
    $('infoSalesPrefecture').value=PREFECTURES.includes(row.prefecture)?row.prefecture:'';
    $('infoSalesMasterHint').textContent='店舗マスターから「'+row.name+'」を選択しました。';
  }
  function resetForm(){
    $('infoSalesForm')?.reset();
    $('infoSalesFormHeading').textContent='新規登録';
    $('infoSalesSave').textContent='保存する';
    editingId='';
    hideStoreSuggestions();
    updateGenre();
  }
  function renderList(){
    const list=$('infoSalesList'),status=$('infoSalesListStatus');
    if(!list||!authorized)return;
    const search=normalize($('infoSalesSearch')?.value);
    const filter=$('infoSalesFilterGenre')?.value||'all';
    const found=rows.filter(row=>
      (filter==='all'||row.genre===filter) &&
      (!search||normalize([row.store_name,row.prefecture,row.notes].join(' ')).includes(search)));
    $('infoSalesCount').textContent=rows.length+'件';
    status.textContent=loading?'登録済みの販売形態を取得中…':
      '保存済み '+rows.length+'件 ／ 表示 '+found.length+'件';
    if(!found.length){
      list.innerHTML='<p class="info-sales-no-results">'+
        (rows.length?'検索に一致する店舗がありません。':'まだ登録された店舗はありません。')+'</p>';
      return;
    }
    list.innerHTML=found.map(row=>{
      const pokemon=row.genre==='pokemon';
      const tags=pokemon
        ? '<span>シュリンク：<strong>'+formatValue(row.shrink_state)+'</strong></span>'+
          '<span>ペリ：<strong>'+formatValue(row.peri_state)+'</strong></span>'
        : '<span>テプカ：<strong>'+formatValue(row.tape_cut_state)+'</strong></span>';
      return '<article class="info-sales-entry">'+
        '<div class="info-sales-entry-heading"><strong>'+escape(row.store_name)+'</strong>'+
          '<small>'+escape(row.prefecture)+' ／ '+(pokemon?'ポケカ':'ワンピース')+'</small></div>'+
        '<div class="info-sales-tags">'+tags+'</div>'+
        (row.notes?'<p class="info-sales-entry-note">'+escape(row.notes)+'</p>':'')+
        '<div class="info-sales-entry-actions">'+
          '<button type="button" data-info-sales-edit="'+escape(row.id)+'">編集</button>'+
          '<button type="button" data-info-sales-delete="'+escape(row.id)+'">削除</button>'+
        '</div>'+
      '</article>';
    }).join('');
  }
  async function refresh(force=false){
    if(!authorized||!canAccess())return false;
    if(loading)return false;
    if(loaded&&!force){renderList();return true;}
    const current=++generation;
    loading=true;renderList();
    try{
      const all=[];
      for(let offset=0;offset<10000;offset+=500){
        const {data,error}=await client().from(TABLE).select(SELECT)
          .order('updated_at',{ascending:false}).range(offset,offset+499);
        if(error)throw error;
        if(current!==generation||!canAccess())return false;
        all.push(...(data||[]));
        if(!data||data.length<500)break;
      }
      if(current!==generation||!canAccess())return false;
      rows=all;loaded=true;return true;
    }catch(error){
      if(current===generation&&authorized)message('販売形態の取得に失敗：'+String(error.message||error),true);
      return false;
    }finally{
      if(current===generation){loading=false;renderList();}
    }
  }
  async function refreshMaster(force=false){
    if(!authorized||!canAccess()||masterBusy||(masterLoaded&&!force))return false;
    const current=generation;
    masterBusy=true;
    const hint=$('infoSalesMasterHint');
    if(hint)hint.textContent='店舗マスターを読み込み中…';
    try{
      const {data,error}=await client().rpc('lottery_store_admin_v1');
      if(error)throw error;
      if(current!==generation||!canAccess())return false;
      const choices=new Map();
      for(const row of Array.isArray(data?.masters)?data.masters:[]){
        if(row?.merged_into||!row?.name||!PREFECTURES.includes(row?.prefecture))continue;
        const label=String(row.prefecture)+'｜'+String(row.name);
        choices.set(label,{name:String(row.name),prefecture:String(row.prefecture)});
      }
      masterChoices=choices;
      masterLoaded=true;
      if(masterSuggestionsOpen)renderStoreSuggestions(true);
      if(hint)hint.textContent='店舗マスター '+choices.size+'件から候補選択できます。候補にない店舗も登録可能です。';
      return true;
    }catch(error){
      if(current===generation&&hint)hint.textContent='店舗マスター候補は取得できませんでした。直接入力して保存できます。';
      return false;
    }finally{masterBusy=false;}
  }
  async function save(event){
    event.preventDefault();
    if(saveBusy||!canAccess()||!authorized)return;
    selectMasterIfExact();
    const name=$('infoSalesStore').value.trim();
    const prefecture=$('infoSalesPrefecture').value;
    const genre=$('infoSalesGenre').value;
    const notes=$('infoSalesNotes').value.trim();
    const shrink=genre==='pokemon'?$('infoSalesShrink').value:'unknown';
    const peri=genre==='pokemon'?$('infoSalesPeri').value:'unknown';
    const tape=genre==='onepiece'?$('infoSalesTape').value:'unknown';
    if(!name||name.length>160||!normalize(name)||!PREFECTURES.includes(prefecture)||
       !['pokemon','onepiece'].includes(genre)){
      message('店舗名・都道府県・カードの種類を正しく入力してください。',true);return;
    }
    if(!['unknown','yes','no'].includes(shrink)||!['unknown','yes','no'].includes(peri)||
       !['unknown','yes','no'].includes(tape)||notes.length>500){
      message('販売形態またはメモの内容を確認してください。',true);return;
    }
    if([shrink,peri,tape].every(value=>value==='unknown')&&!notes){
      message('販売形態を1項目以上選ぶか、補足メモを入力してください。',true);return;
    }
    const user=options.getUserId();
    const payload={
      store_name:name,store_key:normalize(name),prefecture,genre,
      shrink_state:shrink,peri_state:peri,tape_cut_state:tape,
      notes,updated_by:user,updated_at:new Date().toISOString()
    };
    const button=$('infoSalesSave');
    saveBusy=true;button.disabled=true;button.textContent='保存中…';
    message('保存しています…');
    try{
      const query=editingId
        ? client().from(TABLE).update(payload).eq('id',editingId)
        : client().from(TABLE).upsert(payload,{onConflict:'store_key,prefecture,genre'});
      const {data,error}=await query.select('id').single();
      if(error)throw error;
      if(!data?.id||!canAccess()||options.getUserId()!==user)throw Error('保存結果を確認できませんでした');
      loaded=false;
      await refresh(true);
      resetForm();
      message('✅ 店舗別の販売形態を保存しました。');
    }catch(error){
      if(canAccess())message('保存できませんでした：'+String(error.message||error),true);
    }finally{
      saveBusy=false;
      if(button){button.disabled=false;if(editingId)button.textContent='変更を保存';else button.textContent='保存する';}
    }
  }
  function onListClick(event){
    const edit=event.target.closest('button[data-info-sales-edit]');
    const remove=event.target.closest('button[data-info-sales-delete]');
    if(!authorized||!canAccess()||(!edit&&!remove))return;
    const id=(edit||remove).dataset.infoSalesEdit||(edit||remove).dataset.infoSalesDelete;
    const record=rows.find(row=>row.id===id);
    if(!record)return;
    if(remove){deleteRecord(record);return;}
    editingId=record.id;
    $('infoSalesStore').value=record.store_name;
    $('infoSalesPrefecture').value=record.prefecture;
    $('infoSalesGenre').value=record.genre;
    $('infoSalesShrink').value=record.shrink_state;
    $('infoSalesPeri').value=record.peri_state;
    $('infoSalesTape').value=record.tape_cut_state;
    $('infoSalesNotes').value=record.notes||'';
    $('infoSalesFormHeading').textContent='登録内容を編集';
    $('infoSalesSave').textContent='変更を保存';
    updateGenre();message('「'+record.store_name+'」の登録内容を編集中です。');
    try{$('infoSalesForm').scrollIntoView({behavior:'smooth',block:'start'});}catch(_){}
  }
  async function deleteRecord(record){
    if(saveBusy||!canAccess()||!authorized)return;
    if(!confirm('「'+record.store_name+'」の'+(record.genre==='pokemon'?'ポケカ':'ワンピース')+
      '販売形態を削除しますか？'))return;
    const user=options.getUserId();
    saveBusy=true;message('削除しています…');
    try{
      const {data,error}=await client().from(TABLE).delete()
        .eq('id',record.id).select('id');
      if(error)throw error;
      if(!canAccess()||user!==options.getUserId()||!Array.isArray(data)||
         !data.some(row=>row.id===record.id))throw Error('削除結果を確認できませんでした');
      if(editingId===record.id)resetForm();
      loaded=false;
      await refresh(true);
      message('✅ 登録を削除しました。');
    }catch(error){
      if(canAccess())message('削除できませんでした：'+String(error.message||error),true);
    }finally{saveBusy=false;}
  }
  function onAuthChanged(){
    if(!initialized)mount();
    const permitted=canAccess();
    const panel=$('infoSalesAdmin');
    if(!panel)return;
    panel.hidden=!permitted;
    if(permitted!==authorized){
      ++generation;
      authorized=permitted;
      rows=[];loaded=false;masterLoaded=false;masterChoices=new Map();
      hideStoreSuggestions();
      if($('infoSalesStoreSuggestions'))$('infoSalesStoreSuggestions').replaceChildren();
      resetForm();message('');
      if(!permitted){
        $('infoSalesList').replaceChildren();
        $('infoSalesCount').textContent='0件';
        $('infoSalesListStatus').textContent='';
      }
    }
    if(permitted&&active){
      refresh();
      refreshMaster();
    }
  }
  function onTabChanged(tab){
    active=tab==='infoPlaza';
    if(active)onAuthChanged();
  }
  function init(config){
    if(initialized)return;
    options=config;
    mount();
    onAuthChanged();
  }
  window.TorecaInfoPlaza={init,onTabChanged,onAuthChanged};
})();