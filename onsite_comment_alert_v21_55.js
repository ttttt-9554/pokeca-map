/* Stable extension entry point. The original onsite-alert implementation is
 * retained byte-for-byte in onsite_comment_alert_core_v21_55.js. */
(() => {
  'use strict';
  function load(src,id){
    if(document.getElementById(id))return;
    const script=document.createElement('script');script.id=id;script.src=src;
    script.onerror=()=>{script.remove();console.warn('追加機能を読み込めませんでした。画面を更新してください。');};
    document.head.append(script);
  }
  load('onsite_comment_alert_core_v21_55.js?v=20261024-core','onsite-alert-core-loader');
  function init(){
    const view=document.getElementById('devView');if(!view)return;
    const check=()=>{if(!view.hidden&&view.classList.contains('active')){load('guerrilla_sale_dev_v2.js?v=20261031-waiting-room-diagnostics-v21-156','sale-beta-v2-loader');load('sale_push_v1.js?v=20261031-ios-push-v3','sale-push-v1-loader');}};
    new MutationObserver(check).observe(view,{attributes:true,attributeFilter:['hidden','class']});
    check();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
