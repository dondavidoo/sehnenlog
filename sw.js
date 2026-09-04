/* Sehnenlog – Offline-Cache für die App-Hülle.
   Die Trainingsdaten liegen im localStorage und werden hier nicht angefasst. */

const CACHE = 'sehnenlog-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // Einzeln ablegen: ein fehlendes Icon soll nicht die ganze Installation kippen.
    await Promise.all(SHELL.map(u =>
      c.add(new Request(u, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // Seitenaufruf: erst das Netz. So läuft nie eine veraltete Fassung, solange
  // Empfang da ist – und ohne Empfang kommt die letzte gecachte Fassung.
  if (req.mode === 'navigate') {
    ev.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const c = await caches.open(CACHE);
          await c.put('./index.html', fresh.clone());
        }
        return fresh;
      } catch (e) {
        const c = await caches.open(CACHE);
        return (await c.match('./index.html'))
            || (await c.match('./'))
            || new Response('Offline und nichts im Cache.', {
                 status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // Alles andere (Icons, Manifest): aus dem Cache, im Hintergrund auffrischen.
  ev.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    const net = fetch(req)
      .then(r => { if (r && r.ok) c.put(req, r.clone()); return r; })
      .catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
