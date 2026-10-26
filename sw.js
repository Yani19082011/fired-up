// Пази приложението на телефона: първо от мрежата (винаги последна версия), без интернет – от паметта. + известия.
const C='app-v4';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/manifest.webmanifest','/icon.png']).catch(()=>{})).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
  e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))))});
// известие от сървъра
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(_){d={title:'Fired Up',body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'Fired Up',{body:d.body||'',icon:'/icon.png',badge:'/icon.png',data:{url:d.url||'/'},tag:d.tag,renotify:!!d.tag,vibrate:[80,40,80]}))});
// докосване на известието → отваря приложението (и трейдъра, ако има)
self.addEventListener('notificationclick',e=>{e.notification.close();const url=(e.notification.data&&e.notification.data.url)||'/';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{for(const w of ws){if(new URL(w.url).origin===location.origin){w.focus();w.postMessage({open:url});return}}return clients.openWindow(url)}))});
