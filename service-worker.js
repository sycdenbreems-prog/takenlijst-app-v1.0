'use strict';
const CACHE = 'thuisonderhoud-v4';
const FILES = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== CACHE).map(n => caches.delete(n)))).then(() => self.clients.claim()));
});

// Alleen same-origin GET. Eerst netwerk (altijd nieuwste versie), anders cache (offline).
self.addEventListener('fetch', e => {
  const r = e.request, url = new URL(r.url);
  if (r.method !== 'GET' || url.origin !== self.location.origin) return;
  const nav = r.mode === 'navigate';
  e.respondWith(
    fetch(r.url, { cache: 'no-cache' }).then(res => {
      if (res.ok && res.type === 'basic') {
        const cp = res.clone();
        caches.open(CACHE).then(c => c.put(nav ? './index.html' : r.url, cp));
      }
      return res;
    }).catch(() => (nav ? caches.match('./index.html') : caches.match(r.url)).then(m => m || Response.error()))
  );
});
