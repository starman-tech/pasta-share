// 🍝 Pasta Share : service worker (installation + réception des partages Android)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.pathname !== new URL('share', self.registration.scope).pathname) return;
  e.respondWith((async () => {
    const fd = await e.request.formData();
    const files = fd.getAll('files').filter(f => typeof f === 'object' && f.name);
    const text = ['title', 'text', 'url'].map(k => fd.get(k)).filter(Boolean).join('\n');
    if (!files.length && text) files.push(new File([text], 'texte.txt', { type: 'text/plain' }));
    await caches.delete('pasta-share');
    const cache = await caches.open('pasta-share');
    await Promise.all(files.map((f, i) => cache.put(new URL('_shared/' + i, self.registration.scope).href, new Response(f, {
      headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name) },
    }))));
    return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
  })());
});
