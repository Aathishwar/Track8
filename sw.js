/**
 * Track8 - Service worker
 *
 * Three jobs:
 *   1. Cache the app shell so the tracker opens instantly and works with no
 *      network, which is the point of installing it to the home screen.
 *   2. Own notifications. Android Chrome refuses `new Notification(...)` from a
 *      page, so every reminder is posted through this worker, and taps on the
 *      "End break" action are handled here even when no tab is open.
 *   3. Start and end a break or a lunch on its own, without opening the app.
 *      It cannot write the day itself - the event log lives in the page's
 *      localStorage - so it records the tap in js/handoff.js and redraws the
 *      notification from the snapshot the page left there. See actInPlace.
 */

/* Bumped on every release that changes a shell file. It names the cache and it
   is also stamped onto the imports below, which is the part that is easy to get
   wrong: the two modules this worker shares with the page are stored beside the
   worker script in a cache of their own, not the shell cache, and a phone can
   therefore go on drawing notifications from last week's copy of shift-card.js
   while the page in front of the user is running this week's. Changing the URL
   guarantees a fresh fetch rather than trusting the browser to compare bytes. */
var VERSION = 'v18';

var CACHE = 'track8-shell-' + VERSION;

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
  './js/handoff.js',
  './js/shift-card.js',
  './js/notify.js',
  './js/push.js',
  './js/sync.js',
  './js/ui.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-72.png'
];

/* The two modules the page and this worker share. Wrapped because a failed
   importScripts kills the whole worker, and a worker that will not install takes
   the offline shell down with it - a far worse outcome than losing the in-place
   actions. Without these, every notification tap opens the app, exactly as it
   did before. */
try {
  importScripts('./js/handoff.js?' + VERSION, './js/shift-card.js?' + VERSION);
} catch (e) {
  console.warn('Track8 SW: shared modules unavailable, notification taps will open the app.', e);
}

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
 * Route a notification tap.
 *
 * Break and lunch are settled here, by the worker, with no window appearing -
 * see actInPlace. Everything else goes to the app: if a tab is already open we
 * focus it and post the action, and if nothing is open we launch with ?a=… and
 * app.js completes it on boot.
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

/* How long the worker waits for the page to confirm it got the action. Long
   enough for a backgrounded page to be woken and answer, short enough that the
   fallback reload still reads as a response to the tap. */
var ACK_TIMEOUT_MS = 1200;

/**
 * Hand the action to an open copy of the app, and find out whether it landed.
 *
 * `postMessage` is not proof of delivery. Android keeps listing a window client
 * after it has discarded the page behind it, so the message is dropped in
 * silence and focusing that window reloads the app at a plain URL with the tap
 * forgotten. That is exactly why "End break" did nothing half an hour into a
 * break while "Break" worked seconds after using the app: one tap reached a
 * live page and the other reached a ghost.
 *
 * So the page answers on a port it is handed, and silence is read as "there is
 * no page there".
 */
function deliver(client, action) {
  return new Promise(function (resolve) {
    var settled = false;
    function done(ok) {
      if (settled) return;
      settled = true;
      resolve(ok);
    }

    var channel;
    try {
      channel = new MessageChannel();
    } catch (e) {
      // No channel to be answered on, so treat it as undelivered and let the
      // caller reload the window instead of guessing.
      done(false);
      return;
    }

    channel.port1.onmessage = function () { done(true); };
    setTimeout(function () { done(false); }, ACK_TIMEOUT_MS);

    try {
      client.postMessage({ action: action }, [channel.port2]);
    } catch (e) {
      done(false);
    }
  });
}

function focusOrOpen(action) {
  var url = LAUNCH_URL[action] || './';

  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientList) {
      var client = null;
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.indexOf(self.registration.scope) === 0) {
          client = clientList[i];
          break;
        }
      }

      if (!client) return self.clients.openWindow(url);

      // Focus before waiting for the answer, not after: focus() needs the tap's
      // activation, and that does not survive a second of waiting. It also wakes
      // a page the phone had frozen, which is what lets it answer at all.
      var focused = client.focus
        ? client.focus().catch(function () { return null; })
        : Promise.resolve(null);

      return focused
        .then(function () { return deliver(client, action); })
        .then(function (delivered) {
          if (delivered) return null;

          // Nobody answered. Reload that window with the action in the URL and
          // let app.js finish it on boot - the same path a cold launch takes.
          // navigate() rejects for a client this worker does not control, hence
          // the openWindow fallback.
          if (!client.navigate) return self.clients.openWindow(url);
          return client.navigate(url).catch(function () {
            return self.clients.openWindow(url);
          });
        });
    });
}

var ACTION_NAMES = {
  resume: 'resume-work',
  'break': 'break',
  lunch: 'lunch',
  pause: 'pause',
  end: 'end'
};

/* ------------------------------------------------------ acting without the app */

/**
 * The actions this worker can complete on its own, and what they leave the day
 * in.
 *
 * Break and lunch only, in both directions. They are the two that happen with
 * the phone already in a pocket, and the two whose entire point is not having to
 * open anything. Pause, end day and a meeting still open the app: each of those
 * wants the screen anyway, and a meeting has no button here at all because it
 * needs a length nobody can type into a notification.
 *
 * `resume-work` deliberately does not list PAUSED. Coming back from a pause
 * opens the app, which is where that decision belongs.
 */
var IN_PLACE = {
  'break': { from: ['WORKING', 'MEETING'], to: 'BREAK' },
  lunch: { from: ['WORKING', 'MEETING'], to: 'LUNCH' },
  'resume-work': { from: ['BREAK', 'LUNCH'], to: 'WORKING' }
};

/**
 * Where the day stands once this action is applied.
 *
 * Credited time is carried rather than recomputed, because the worker has no
 * event log to walk. T8Shift.creditedAt does the banking in both directions:
 * leaving WORKING or MEETING adds the stretch that has just finished, and
 * leaving a break adds nothing, which is the whole reason a break is not
 * credited.
 */
function nextSnapshot(snap, action, now) {
  return {
    state: IN_PLACE[action].to,
    openSince: now,
    creditedBeforeMs: self.T8Shift.creditedAt(snap, now),
    breakAlertMinutes: snap.breakAlertMinutes,
    breakRepeatMinutes: snap.breakRepeatMinutes,
    lunchAlertMinutes: snap.lunchAlertMinutes,
    lunchRepeatMinutes: snap.lunchRepeatMinutes
  };
}

/* A static host answers /api/… with the app's own HTML and a cheerful 200, so a
   200 is not proof a server heard us. Same rule js/push.js applies. */
function apiJson(url, method, payload) {
  return fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (response) {
    if (!response.ok) return false;
    var type = response.headers.get('content-type') || '';
    return type.indexOf('application/json') !== -1;
  }).catch(function () { return false; });
}

/**
 * Arm or cancel this device's server reminder, with no page involved.
 *
 * The record is keyed by the push endpoint, which belongs to this worker, so it
 * can do this itself. That matters more than it looks. The keep-alive audio
 * track is a page's to start and the worker cannot fake it, so for a break
 * begun from the shade with the app closed, the server is the layer that
 * actually delivers the reminder.
 */
function syncServerReminder(snap) {
  if (!self.registration.pushManager) return Promise.resolve(false);

  return self.registration.pushManager.getSubscription()
    .then(function (sub) {
      if (!sub) return false;

      if (snap.state !== 'BREAK' && snap.state !== 'LUNCH') {
        return apiJson('./api/reminders', 'DELETE', { endpoint: sub.endpoint });
      }

      var lunch = snap.state === 'LUNCH';
      return apiJson('./api/reminders', 'POST', {
        subscription: sub.toJSON(),
        kind: lunch ? 'LUNCH' : 'BREAK',
        startedAt: snap.openSince,
        firstMinutes: lunch ? snap.lunchAlertMinutes : snap.breakAlertMinutes,
        repeatMinutes: lunch ? snap.lunchRepeatMinutes : snap.breakRepeatMinutes
      });
    })
    .catch(function () { return false; });
}

function clearTag(tag) {
  if (!self.registration.getNotifications) return Promise.resolve(false);
  return self.registration.getNotifications({ tag: tag })
    .then(function (list) {
      list.forEach(function (n) { n.close(); });
      return true;
    })
    .catch(function () { return false; });
}

/**
 * Tell a live page to file what was just queued - without focusing it. A window
 * appearing is the one thing an in-place action exists to avoid.
 */
function nudgeClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        try { clientList[i].postMessage({ action: 'drain' }); } catch (e) { /* a ghost page */ }
      }
      return true;
    })
    .catch(function () { return true; });
}

/**
 * Settle a break or lunch here and now.
 *
 * Resolves false when this cannot be done - no shared modules, no snapshot, a
 * state the action does not apply to, no storage to record the tap in - and the
 * caller then opens the app, which is what every action used to do. Failing back
 * to the old behaviour is always correct; guessing is not.
 *
 * Note what is recorded: the action and the moment it was tapped, not a
 * duration. The app files it into the log later and the arithmetic comes out the
 * same, because durations here are always the difference between two timestamps.
 */
function actInPlace(action) {
  if (!IN_PLACE[action] || !self.T8Handoff || !self.T8Shift) return Promise.resolve(false);

  return self.T8Handoff.snapshot().then(function (snap) {
    if (!snap || IN_PLACE[action].from.indexOf(snap.state) === -1) return false;

    var now = Date.now();
    var next = nextSnapshot(snap, action, now);

    return self.T8Handoff.queue(action, now).then(function (id) {
      // Nothing stored the tap, so it would be lost. Open the app instead of
      // redrawing a notification that claims work nobody will ever file.
      if (id === null || id === undefined) return false;

      return self.T8Handoff.putSnapshot(next)
        .then(function () {
          return self.registration.showNotification(
            self.T8Shift.title(next),
            self.T8Shift.options(next, now)
          );
        })
        // The nag belonged to the break that has just ended.
        .then(function () { return clearTag('t8-nag'); })
        .then(function () { return syncServerReminder(next); })
        .then(function () { return nudgeClients(); })
        .then(function () { return true; });
    });
  }).catch(function () { return false; });
}

self.addEventListener('notificationclick', function (event) {
  var action = event.action;
  event.notification.close();

  var name = ACTION_NAMES[action];
  if (!name) {
    // Tapping the body of a break reminder means the same thing in practice.
    var data = event.notification.data || {};
    name = data.kind === 'nag' ? 'resume-work' : 'open';
  }

  event.waitUntil(
    actInPlace(name).then(function (settled) {
      return settled ? null : focusOrOpen(name);
    })
  );
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
