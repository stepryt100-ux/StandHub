// sw.js — нужен, чтобы StandHub можно было добавить значком на экран телефона или компьютера.
// Страницы всегда загружаются из сети (сразу свежая версия сайта). Если интернета нет — показываем страницу «Нет подключения».
// Запросы к /api/, картинки и остальные файлы не трогаем.
const CACHE = 'standhub-offline-1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add(new Request('/offline.html', { cache: 'reload' }))).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => { for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k); await self.clients.claim(); })());
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || r.mode !== 'navigate') return;
  e.respondWith(fetch(r).catch(async () => (await caches.match('/offline.html')) || new Response('Нет подключения к интернету', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })));
});
