// Пази приложението на телефона: първо от мрежата (винаги последна версия), без интернет – от паметта.
const C='app-v3';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/manifest.webmanifest','/icon.png']).catch(()=>{})).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
  e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))))});
