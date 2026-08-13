/**
 * Track8 - app host and push sender
 *
 * Two jobs, and they are on the same origin on purpose: a push subscription
 * belongs to the origin that registered the service worker, so serving the app
 * and the API from one place means no CORS and no second domain to keep in
 * sync.
 *
 *   1. Serve the static app exactly as a file host would.
 *   2. Hold "wake this phone at this time" records and send the push.
 *
 * The app still works without any of this. If the API is unreachable the client
 * falls back to the three on-device reminder layers it has always had, so the
 * folder remains deployable to a plain static host.
 */
// Local development only. dotenv never overwrites a variable that is already
// set, so on Render - where the values come from the dashboard and no .env
// file exists - this is a no-op.
try { require('dotenv').config(); } catch (e) { /* not installed, not needed */ }

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const webpush = require('web-push');

const reminders = require('./reminders');
const db = require('./db');
const auth = require('./auth');
const mail = require('./mail');
const sync = require('./sync');

const PORT = process.env.PORT || 3000;
const APP_DIR = path.resolve(__dirname, '..');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:track8@example.com';

const pushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  // Deliberately not fatal. A deploy with no keys still serves the app, which
  // is strictly better than refusing to boot; the client sees an unconfigured
  // key endpoint and quietly stays on its on-device reminders.
  console.warn('[track8] VAPID keys missing - serving the app, push disabled. Run `npm run keys`.');
}

const app = express();

// Render terminates TLS in front of the app, so req.secure and the client IP
// both come from the proxy headers. Without this the session cookie would not
// be marked Secure and the rate limiter would see one address for everyone.
app.set('trust proxy', 1);

// Generous enough for a first sync carrying a year of days, which is a few
// hundred kilobytes of event logs.
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use(auth.attachAccount);

/* -------------------------------------------------------------- static app */

// The server's own source sits inside the folder being served. Nothing secret
// is in it - the keys live in the environment - but there is no reason to hand
// it out.
app.use('/server', (req, res) => res.status(404).end());

app.use(express.static(APP_DIR, {
  extensions: false,
  setHeaders(res, filePath) {
    const name = path.basename(filePath);
    // The worker and the manifest decide when everything else updates. Letting
    // a CDN or the browser hold an old copy is how an app gets stuck on a
    // previous version for days.
    if (name === 'sw.js' || name === 'manifest.webmanifest' || name === 'index.html') {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(png|ico)$/.test(name)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

/* -------------------------------------------------------------------- api */

/** Ping target for the cron job that stops Render idling the instance. */
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    push: pushConfigured,
    pending: reminders.size(),
    sync: db.configured(),
    mail: mail.configured()
  });
});

/* ------------------------------------------------------------------- auth */

app.post('/api/auth/request-code', auth.requestCode);
app.post('/api/auth/verify', auth.verifyCode);
app.get('/api/auth/me', auth.me);
app.post('/api/auth/logout', auth.logout);

// The only route that touches attendance data, and the only one that needs an
// account. requireAccount runs first, so an expired or missing session can
// never reach a query.
app.post('/api/sync', auth.requireAccount, sync.handleSync);

app.get('/api/vapid-key', (req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: 'push not configured' });
  res.json({ key: VAPID_PUBLIC_KEY });
});

function validSubscription(sub) {
  return sub &&
    typeof sub.endpoint === 'string' &&
    /^https:\/\//.test(sub.endpoint) &&
    sub.endpoint.length < 1024 &&
    sub.keys &&
    typeof sub.keys.p256dh === 'string' &&
    typeof sub.keys.auth === 'string';
}

function clampMinutes(value, min, max, fallback) {
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Arm a reminder for one phone.
 *
 * Called when a break starts, and again whenever the app is opened with a
 * break still running - that repeat is what heals a record lost to a restart.
 * Upserting by endpoint means re-registering the same break is harmless.
 */
app.post('/api/reminders', (req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: 'push not configured' });

  const body = req.body || {};
  if (!validSubscription(body.subscription)) {
    return res.status(400).json({ error: 'invalid subscription' });
  }

  const startedAt = Number(body.startedAt);
  if (!isFinite(startedAt) || startedAt <= 0) {
    return res.status(400).json({ error: 'invalid startedAt' });
  }

  // A phone with a wrong clock could otherwise park a reminder in the far
  // future or claim a break began last year.
  const now = Date.now();
  const safeStart = Math.min(Math.max(startedAt, now - 12 * 60 * 60 * 1000), now + 60 * 1000);

  const kind = body.kind === 'LUNCH' ? 'LUNCH' : 'BREAK';
  const firstMinutes = clampMinutes(body.firstMinutes, 1, 240, 15);
  const repeatMinutes = clampMinutes(body.repeatMinutes, 1, 60, 5);

  const record = {
    subscription: body.subscription,
    kind,
    startedAt: safeStart,
    firstMinutes,
    repeatMinutes,
    dueAt: safeStart + firstMinutes * 60000,
    pushCount: 0
  };

  try {
    reminders.add(record);
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }

  res.json({ ok: true, dueAt: record.dueAt });
});

/** Break ended. The client also calls this on open when nothing is running. */
app.delete('/api/reminders', (req, res) => {
  const endpoint = (req.body || {}).endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    return res.status(400).json({ error: 'endpoint required' });
  }
  res.json({ ok: true, removed: reminders.remove(endpoint) });
});

/* ------------------------------------------------------------------- boot */

// Anything not matched above is the app itself - the client has no routes, so
// this only matters for a refresh on a URL with a query string.
app.get('*', (req, res) => res.sendFile(path.join(APP_DIR, 'index.html')));

reminders.load();
reminders.startScheduler();

// The schema is created on boot rather than by a migration tool: it is a
// handful of `if not exists` statements, and a deploy that cannot reach the
// database should still serve the app rather than refuse to start.
db.init()
  .catch((e) => console.error('[db] init failed, sync disabled:', e.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`[track8] listening on ${PORT}` +
        `, push ${pushConfigured ? 'on' : 'off'}` +
        `, sync ${db.configured() ? 'on' : 'off'}` +
        `, mail ${mail.configured() ? 'on' : 'off'}`);
    });
  });
