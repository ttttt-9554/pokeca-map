/* Toreca Radar Web Push service worker.
 * No fetch/cache interception: existing app update behavior remains untouched.
 */
self.addEventListener('push', event => {
  let data={};
  try { data=event.data ? event.data.json() : {}; } catch (_) {}
  const title=String(data.title||'⚡ トレカ販売通知').slice(0,120);
  const options={
    body:String(data.body||'販売情報を検知しました').slice(0,240),
    icon:data.icon||'./icon-192.png',
    badge:data.badge||'./icon-192.png',
    tag:String(data.tag||'toreca-sale').slice(0,120),
    renotify:true,
    silent:false,
    data:{url:data.url||'./',site:data.site||'',state:data.state||''}
  };
  event.waitUntil((async()=>{
    await self.registration.showNotification(title,options);
    try {
      if (self.navigator && typeof self.navigator.setAppBadge==='function') {
        await self.navigator.setAppBadge(1);
      }
    } catch (_) {}
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target=new URL(event.notification?.data?.url||'./',self.location.origin);
  event.waitUntil((async()=>{
    if(target.origin!==self.location.origin){
      return clients.openWindow(target.href);
    }
    const list=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of list){
      if('focus' in client){
        try{await client.navigate(target.href);}catch(_){}
        return client.focus();
      }
    }
    return clients.openWindow(target.href);
  })());
});
