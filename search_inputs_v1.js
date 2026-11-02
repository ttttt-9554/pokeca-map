/* Shared search fields: separate clear button, matching suggestions only. */
(() => {
  'use strict';
  const SELECTOR='input[type="search"],input[name="product_name"],input[name="store_name"],input[name="extra_store_name"],input[data-lp-store-name],input[data-lp-app-store-name],input[data-lp-ext-store-name],input[data-lp-manual-store-name],input[data-lp-manual-store-pref],#shop,#cloudStoreName,#cloudProductName';
  const EXISTING=new Set(['product','mapProductSearch','wishlistSearch','storeQuery']);
  const states=new Map();
  let config=null,serial=0;
  const normalize=value=>config?.normalize?.(value)??String(value||'').normalize('NFKC').toLocaleLowerCase('ja-JP');

  function sync(state){
    state.clear.disabled=!state.input.value||state.input.disabled||state.input.readOnly;
    state.clear.hidden=false;
  }
  function close(state){
    state.revision++;
    if(!state.list)return;
    state.list.hidden=true;state.active=-1;
    state.input.setAttribute('aria-expanded','false');
    state.input.removeAttribute('aria-activedescendant');
  }
  function candidates(state){
    const query=normalize(state.input.value);
    if(!query)return [];
    const supplied=config.suggestions?.(state.input)||[];
    const native=state.nativeList?[...state.nativeList.options].map(option=>({value:option.value})):[];
    const seen=new Set(),matching=[];
    for(const raw of [...supplied,...native]){
      const choice=typeof raw==='string'?{value:raw}:raw;
      if(!choice||typeof choice.value!=='string'||!choice.value.trim())continue;
      const identity=choice.value+'|'+(choice.prefecture||'');
      if(seen.has(identity))continue;
      seen.add(identity);
      const text=normalize([choice.value,choice.detail,choice.search].filter(Boolean).join(' '));
      if(text.includes(query))matching.push(choice);
    }
    return matching.sort((a,b)=>Number(normalize(b.value).startsWith(query))-
      Number(normalize(a.value).startsWith(query))).slice(0,60);
  }
  function choose(state,choice){
    const input=state.input;
    input.value=input.maxLength>0?choice.value.slice(0,input.maxLength):choice.value;
    config.select?.(input,choice);
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    input.focus({preventScroll:true});
    close(state);sync(state);
  }
  function renderMatches(state){
    if(state.composing)return close(state);
    state.choices=candidates(state);state.active=-1;
    if(!state.choices.length)return close(state);
    state.input.removeAttribute('aria-activedescendant');
    state.list.replaceChildren();
    state.choices.forEach((choice,index)=>{
      const button=document.createElement('button');
      button.type='button';button.className='tr-search-option';
      button.id=state.list.id+'-'+index;button.tabIndex=-1;
      button.setAttribute('role','option');button.setAttribute('aria-selected','false');
      const name=document.createElement('strong');name.textContent=choice.value;
      button.append(name);
      if(choice.detail){
        const detail=document.createElement('small');detail.textContent=choice.detail;
        button.append(detail);
      }
      button.addEventListener('mousedown',event=>event.preventDefault());
      button.addEventListener('click',event=>{event.preventDefault();choose(state,choice);});
      state.list.append(button);
    });
    state.list.hidden=false;state.input.setAttribute('aria-expanded','true');
  }
  function open(state){
    if(!state.list)return;
    if(state.composing||state.input.disabled||state.input.readOnly||!normalize(state.input.value))return close(state);
    for(const other of states.values())if(other!==state)close(other);
    renderMatches(state);
    const revision=++state.revision;
    const pending=config.prepare?.(state.input);
    if(pending?.then)pending.then(()=>{
      if(state.revision===revision&&document.activeElement===state.input&&state.active<0)renderMatches(state);
    }).catch(error=>console.warn('検索候補を読み込めませんでした:',error?.message||error));
  }
  function move(state,delta){
    if(!state.choices.length||state.list.hidden)return;
    state.active=state.active<0?(delta>0?0:state.choices.length-1):
      (state.active+delta+state.choices.length)%state.choices.length;
    const buttons=state.list.querySelectorAll('[role="option"]');
    buttons.forEach((button,index)=>button.setAttribute('aria-selected',String(index===state.active)));
    const current=buttons[state.active];
    state.input.setAttribute('aria-activedescendant',current.id);
    current.scrollIntoView({block:'nearest'});
  }
  function install(input){
    if(states.has(input)||input.type==='hidden'||input.hidden||input.id==='infoSalesStore')return;
    const external=EXISTING.has(input.id)||input.getAttribute('role')==='combobox';
    if(!input.hasAttribute('aria-label')&&!input.hasAttribute('aria-labelledby')){
      const label=[...(input.labels||[])].map(node=>node.textContent.trim()).filter(Boolean).join(' ');
      if(label)input.setAttribute('aria-label',label);
    }
    const wrapper=document.createElement('span');wrapper.className='tr-search-field';
    const row=document.createElement('span');row.className='tr-search-row';
    input.before(wrapper);wrapper.append(row);row.append(input);
    const existing=input.id?document.getElementById(input.id+'Clear'):null;
    const clear=existing||document.createElement('button');
    clear.type='button';clear.classList.add('tr-search-clear');clear.textContent='×';
    clear.setAttribute('aria-label','入力をクリア');clear.title='クリア';row.append(clear);
    const state={input,wrapper,clear,list:null,active:-1,choices:[],revision:0,composing:false};
    states.set(input,state);input.classList.add('tr-search-input');
    if(!existing)clear.addEventListener('click',event=>{
      event.preventDefault();input.value='';
      config.clear?.(input);
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
      input.focus({preventScroll:true});close(state);sync(state);
    });
    if(!external){
      const nativeId=input.getAttribute('list');
      state.nativeList=nativeId?document.getElementById(nativeId):null;
      input.removeAttribute('list');input.setAttribute('autocomplete','off');
      input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');
      input.setAttribute('aria-expanded','false');input.setAttribute('aria-haspopup','listbox');
      const list=document.createElement('div');list.className='tr-search-options';list.hidden=true;
      list.id='tr-search-options-'+(++serial);list.setAttribute('role','listbox');
      list.setAttribute('aria-label','入力候補');input.setAttribute('aria-controls',list.id);
      wrapper.append(list);state.list=list;
      input.addEventListener('focus',()=>open(state));
      input.addEventListener('click',()=>open(state));
      input.addEventListener('input',event=>{if(event.isComposing)close(state);else open(state);});
      input.addEventListener('compositionstart',()=>{state.composing=true;close(state);});
      input.addEventListener('compositionend',()=>{state.composing=false;open(state);});
      input.addEventListener('keydown',event=>{
        if(event.isComposing||state.composing||event.keyCode===229)return;
        if(event.key==='Escape'){
          if(!list.hidden){close(state);event.preventDefault();event.stopPropagation();}
        }else if(event.key==='ArrowDown'||event.key==='ArrowUp'){
          event.preventDefault();if(list.hidden)open(state);
          move(state,event.key==='ArrowDown'?1:-1);
        }else if(event.key==='Enter'&&!list.hidden&&state.active>=0){
          event.preventDefault();event.stopPropagation();choose(state,state.choices[state.active]);
        }else if(event.key==='Tab')close(state);
      });
    }
    input.addEventListener('input',()=>sync(state));
    input.addEventListener('change',()=>sync(state));
    input.addEventListener('focus',()=>sync(state));
    sync(state);
  }
  function scan(root){
    if(root.nodeType===1&&root.matches(SELECTOR))install(root);
    root.querySelectorAll?.(SELECTOR).forEach(install);
  }
  function refresh(root=document){
    if(!config)return;
    scan(root);
    for(const [input,state] of states){
      if(!input.isConnected){states.delete(input);continue;}
      sync(state);
      if(state.list&&document.activeElement===input)renderMatches(state);
    }
  }
  function init(options){
    if(config)return;
    config=options;scan(document);
    document.addEventListener('pointerdown',event=>{
      for(const state of states.values())if(!state.wrapper.contains(event.target))close(state);
    });
    document.addEventListener('focusin',event=>{
      for(const state of states.values())if(!state.wrapper.contains(event.target))close(state);
    });
    document.addEventListener('close',event=>{
      for(const state of states.values())if(event.target.contains(state.input))close(state);
    },true);
    document.addEventListener('reset',()=>queueMicrotask(()=>refresh()),true);
    new MutationObserver(records=>{
      for(const record of records)for(const node of record.addedNodes)scan(node);
      for(const [input,state] of states){
        if(!input.isConnected)states.delete(input);else sync(state);
      }
    }).observe(document.body,{childList:true,subtree:true});
  }
  window.TorecaSearchInputs={init,refresh};
})();
