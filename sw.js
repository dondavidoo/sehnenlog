/* Sehnenlog – Offline-Cache für die App-Hülle.
   Die Trainingsdaten liegen im localStorage und werden hier nicht angefasst. */

const CACHE = 'sehnenlog-shell-v2';
const NET_TIMEOUT_MS = 3000;   // länger wartet niemand im Bett auf einen Balken LTE
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
    // Nur eigene alte Caches räumen – auf github.io teilen sich alle Projekte eines Kontos die Origin
    await Promise.all(keys.filter(k => k.startsWith('sehnenlog-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // Seitenaufruf: erst das Netz, aber höchstens NET_TIMEOUT_MS lang. So läuft nie eine
  // veraltete Fassung, solange Empfang da ist – und bei hängendem Netz, ohne Empfang
  // oder einer Fehlerseite des Servers kommt die letzte gecachte Fassung.
  if (req.mode === 'navigate') {
    ev.respondWith((async () => {
      const c = await caches.open(CACHE);
      const cached = async () => (await c.match('./index.html')) || (await c.match('./'));
      const path = new URL(req.url).pathname;
      const isApp = path.endsWith('/') || path.endsWith('/index.html');
      let fresh = null;
      try {
        fresh = await Promise.race([
          fetch(req),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), NET_TIMEOUT_MS))
        ]);
      } catch (e) { fresh = null; }
      if (fresh && fresh.ok) {
        // Nur die App selbst unter ./index.html ablegen – nicht Manifest oder Icons, die jemand direkt aufruft
        if (isApp) await c.put('./index.html', fresh.clone());
        return fresh;
      }
      const hit = isApp ? await cached() : null;
      if (hit) return hit;
      if (fresh) return fresh;   // Fehlerseite ist besser als nichts, wenn der Cache leer ist
      return new Response('Offline und nichts im Cache.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })());
    return;
  }

  // Alles andere (Icons, Manifest): aus dem Cache, im Hintergrund auffrischen.
  ev.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    const net = fetch(req)
      .then(r => { if (r && r.ok) ev.waitUntil(c.put(req, r.clone()).catch(() => {})); return r; })
      .catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
