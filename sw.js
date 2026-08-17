/**
 * Track8 - Service worker
 *
 * Two jobs:
 *   1. Cache the app shell so the tracker opens instantly and works with no
 *      network, which is the point of installing it to the home screen.
 *   2. Own notifications. Android Chrome refuses `new Notification(...)` from a
 *      page, so every reminder is posted through this worker, and taps on the
 *      "End break" action are handled here even when no tab is open.
 */

var CACHE = 'track8-shell-v11';

var SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/timeline.js',
  './js/store.js',
  './js/xlsx.js',
  './js/report.js',
  './js/quips-english.js',
  './js/quips-tanglish.js',
  './js/quips.js',
  './js/notify.js',
  './js/push.js',
  './js/sync.js',
  './js/ui.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-72.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      // addAll rejects the whole batch if any single request fails, which would
      // leave the app uninstallable over one missing icon. Cache individually.
      .then(function (cache) {
        return Promise.all(SHELL.map(function (url) {
          return cache.add(url).catch(function (e) {
            console.warn('Track8 SW: could not cache ' + url, e);
          });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE ? null : caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/**
 * Network first, cache as the fallback.
 *
 * The whole app is a few tens of kilobytes, so fetching it fresh costs almost
 * nothing online and guarantees an updated version is picked up the moment it
 * is published. Offline behaviour is unchanged: the cache answers immediately
 * once the network fails.
 *
 * Cache-first would be marginally faster to first paint, at the price of the
 * user running yesterday's code for one more launch after every update.
 */
self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The push server shares this origin, and its answers are about right now.
  // Caching them would replay a stale "reminder registered" and, worse, serve
  // one from the cache while offline as though the server had heard us.
  if (url.pathname.indexOf('/api/') !== -1 || url.pathname.indexOf('/healthz') !== -1) return;

  event.respondWith(
    fetch(request)
      .then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      })
      .catch(function () {
        return caches.match(request).then(function (cached) {
          return cached || caches.match('./index.html');
        });
      })
  );
});

/**
 * Route a notification tap back into the app.
 *
 * If a tab is already open we focus it and post the action, so the break ends
 * without a reload. If nothing is open we launch the app with ?a=resume and
 * app.js completes the action on boot.
 */
/* The buttons on the pinned shift notification. Every one of them is an action
   the timer screen has, so the worker only has to name it - app.js owns what it
   means. `open` is the fallback for a plain tap on the body. */
var LAUNCH_URL = {
  'resume-work': './?a=resume',
  'break': './?a=break',
  'lunch': './?a=lunch',
  'pause': './?a=pause',
  'end': './?a=end'
};

function focusOrOpen(action) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(self.registration.scope) === 0) {
          client.postMessage({ action: action });
          return client.focus();
        }
      }
      return self.clients.openWindow(LAUNCH_URL[action] || './');
    });
}

var ACTION_NAMES = {
  resume: 'resume-work',
  'break': 'break',
  lunch: 'lunch',
  pause: 'pause',
  end: 'end'
};

self.addEventListener('notificationclick', function (event) {
  var action = event.action;
  event.notification.close();

  if (ACTION_NAMES[action]) {
    event.waitUntil(focusOrOpen(ACTION_NAMES[action]));
    return;
  }

  // Tapping the body of a break reminder means the same thing in practice.
  var data = event.notification.data || {};
  if (data.kind === 'nag') {
    event.waitUntil(focusOrOpen('resume-work'));
    return;
  }

  event.waitUntil(focusOrOpen('open'));
});

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
});

/**
 * A reminder sent by the server.
 *
 * This is the only reminder layer that does not depend on the page surviving
 * in the background, which is the one thing phones refuse to guarantee. The
 * worker is woken by the push service, so nothing of ours needs to have stayed
 * alive - no silent audio, no battery exemption.
 *
 * The same tag as the in-app nag on purpose: if both layers fire, the second
 * replaces the first instead of stacking two notifications about one break.
 */
self.addEventListener('push', function (event) {
  var payload = { title: '⏰ Track8 reminder', body: 'You may still be on a break.' };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (e) { /* fall back to the default copy */ }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: 't8-nag',
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 300],
      badge: './icons/badge-72.png',
      icon: './icons/icon-192.png',
      data: { kind: 'nag' },
      actions: [{ action: 'resume', title: payload.actionTitle || 'End break' }]
    })
  );
});

/**
 * The browser can retire a subscription on its own - a long silence, a data
 * clear, an app update. Re-subscribing here keeps server reminders alive
 * without waiting for the user to next open the app.
 */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    fetch('./api/vapid-key')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        return self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: data.key
        });
      })
      .catch(function () { /* the app re-subscribes on its next launch */ })
  );
});
