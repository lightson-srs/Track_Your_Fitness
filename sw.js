const CACHE_NAME = 'track-your-fitness-v25';
const FILES_TO_CACHE = [
  './', './index.html', './css/styles.css',
  './js/utils.js', './js/qrcode-lib.js', './js/license.js', './js/db.js', './js/settings.js',
  './js/license-registry-config.js', './js/firestore-config.js', './js/sync-engine.js', './js/setup-wizard.js', './js/license-registry.js',
  './js/members.js', './js/contributions.js',
  './js/monthly.js', './js/guestplay.js',
  './js/expenses.js', './js/history.js', './js/reports.js',
  './js/whatsapp.js', './js/backup.js', './js/app.js',
  './icons/icon-192.png', './icons/icon-512.png', './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(FILES_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // Notify all open tabs to reload with new version
        self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then(c => c || fetch(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});
