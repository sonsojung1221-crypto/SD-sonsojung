const CACHE = 'silent-camera-v3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x.startsWith('silent-camera') && x !== CACHE).map(x => caches.delete(x))))));
self.addEventListener('fetch', e => {
  // 카메라 앱 파일만 처리 (dibut-ai 챗봇과 외부 요청은 건드리지 않음)
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || u.pathname.includes('/dibut-ai/')) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
