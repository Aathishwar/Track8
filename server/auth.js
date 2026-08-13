/**
 * Track8 - sign in with an emailed code
 *
 * No password, no signup step: an address that has never been seen becomes an
 * account the first time it proves it can receive a code. That removes the
 * usual "does this email exist?" leak too, because every address behaves
 * identically.
 *
 * The session cookie is the only place an account id ever comes from. Nothing
 * downstream reads an account or profile id out of a request body, because a
 * body is written by whoever is calling, and this is a public endpoint on a
 * public repository.
 */
const crypto = require('crypto');
const db = require('./db');
const mail = require('./mail');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// Sending is free to the caller and costs us a mail quota, so it is capped
// both per address and per source. Without this, anyone can burn 300 emails a
// day and post sign-in codes to strangers using a verified sender.
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_IP_SENDS_PER_HOUR = 20;

const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const COOKIE = 't8session';

const ipHits = new Map();

/* ---------------------------------------------------------------- helpers */

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Six digits, from the CSPRNG rather than Math.random. */
function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Comparison that does not leak how much of the code was right, via timing. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.ip || 'unknown';
}

function ipAllowed(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (hits.length >= MAX_IP_SENDS_PER_HOUR) {
    ipHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) ipHits.clear();
  return true;
}

/* ------------------------------------------------------------- middleware */

/**
 * Resolve the session cookie to an account, or leave the request anonymous.
 *
 * Never throws and never blocks: endpoints that need an account check for it
 * themselves, so an expired session degrades to "signed out" rather than an
 * error the user cannot act on.
 */
async function attachAccount(req, res, next) {
  req.account = null;
  const token = req.cookies ? req.cookies[COOKIE] : null;
  if (!token || !db.configured()) return next();

  try {
    const { rows } = await db.query(
      `select s.account_id, a.email
         from sessions s
         join accounts a on a.id = s.account_id
        where s.token_hash = $1 and s.expires_at > now()`,
      [sha256(token)]
    );
    if (rows.length) {
      req.account = { id: rows[0].account_id, email: rows[0].email };
      // Cheap liveness, useful for pruning abandoned sessions later.
      db.query('update sessions set last_seen_at = now() where token_hash = $1', [sha256(token)])
        .catch(() => { /* not worth failing a request over */ });
    }
  } catch (e) {
    console.warn('[auth] session lookup failed:', e.message);
  }
  next();
}

function requireAccount(req, res, next) {
  if (!req.account) return res.status(401).json({ error: 'not signed in' });
  next();
}

/* ----------------------------------------------------------------- routes */

async function requestCode(req, res) {
  if (!db.configured()) return res.status(503).json({ error: 'sync not configured' });

  const email = normaliseEmail((req.body || {}).email);
  if (!validEmail(email)) return res.status(400).json({ error: 'enter a valid email address' });

  if (!ipAllowed(clientIp(req))) {
    return res.status(429).json({ error: 'too many requests, try again later' });
  }

  try {
    const { rows } = await db.query('select * from login_codes where email = $1', [email]);
    const existing = rows[0];

    if (existing) {
      const sinceSent = Date.now() - new Date(existing.sent_at).getTime();
      if (sinceSent < RESEND_COOLDOWN_MS) {
        return res.status(429).json({
          error: 'a code was just sent, check your inbox',
          retryInSeconds: Math.ceil((RESEND_COOLDOWN_MS - sinceSent) / 1000)
        });
      }
      // The hourly count only resets once the window has fully passed, so a
      // steady trickle cannot creep past the cap.
      if (sinceSent < 60 * 60 * 1000 && existing.sent_count >= MAX_SENDS_PER_HOUR) {
        return res.status(429).json({ error: 'too many codes requested, try again in an hour' });
      }
    }

    const code = newCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    const resetCount = !existing || Date.now() - new Date(existing.sent_at).getTime() >= 60 * 60 * 1000;

    await db.query(
      `insert into login_codes (email, code_hash, expires_at, attempts, sent_at, sent_count)
       values ($1, $2, $3, 0, now(), 1)
       on conflict (email) do update
          set code_hash = excluded.code_hash,
              expires_at = excluded.expires_at,
              attempts = 0,
              sent_at = now(),
              sent_count = case when $4 then 1 else login_codes.sent_count + 1 end`,
      [email, sha256(code), expiresAt, resetCount]
    );

    const sent = await mail.sendLoginCode(email, code);
    if (!sent.ok) {
      return res.status(502).json({ error: 'could not send the email, try again in a moment' });
    }

    res.json({ ok: true, expiresInSeconds: CODE_TTL_MS / 1000 });
  } catch (e) {
    console.error('[auth] requestCode failed:', e.message);
    res.status(500).json({ error: 'something went wrong, try again' });
  }
}

async function verifyCode(req, res) {
  if (!db.configured()) return res.status(503).json({ error: 'sync not configured' });

  const email = normaliseEmail((req.body || {}).email);
  const code = String((req.body || {}).code || '').trim();

  if (!validEmail(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'enter the 6-digit code' });
  }

  try {
    const { rows } = await db.query('select * from login_codes where email = $1', [email]);
    const record = rows[0];

    // Identical response for "never asked", "expired" and "wrong", so nothing
    // can be learned by probing.
    const reject = () => res.status(400).json({ error: 'that code is wrong or has expired' });

    if (!record) return reject();
    if (new Date(record.expires_at).getTime() < Date.now()) {
      await db.query('delete from login_codes where email = $1', [email]);
      return reject();
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      await db.query('delete from login_codes where email = $1', [email]);
      return reject();
    }
    if (!safeEqual(sha256(code), record.code_hash)) {
      await db.query('update login_codes set attempts = attempts + 1 where email = $1', [email]);
      return reject();
    }

    await db.query('delete from login_codes where email = $1', [email]);

    // First correct code for an address creates the account. There is no
    // separate signup to get wrong.
    const account = await db.query(
      `insert into accounts (email) values ($1)
       on conflict (email) do update set email = excluded.email
       returning id, email`,
      [email]
    );
    const accountId = account.rows[0].id;

    const token = newSessionToken();
    await db.query(
      `insert into sessions (token_hash, account_id, expires_at)
       values ($1, $2, $3)`,
      [sha256(token), accountId, new Date(Date.now() + SESSION_TTL_MS)]
    );

    res.cookie(COOKIE, token, {
      httpOnly: true,
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      path: '/'
    });

    res.json({ ok: true, email });
  } catch (e) {
    console.error('[auth] verifyCode failed:', e.message);
    res.status(500).json({ error: 'something went wrong, try again' });
  }
}

async function me(req, res) {
  res.json({
    signedIn: Boolean(req.account),
    email: req.account ? req.account.email : null,
    syncAvailable: db.configured()
  });
}

async function logout(req, res) {
  const token = req.cookies ? req.cookies[COOKIE] : null;
  if (token && db.configured()) {
    await db.query('delete from sessions where token_hash = $1', [sha256(token)])
      .catch(() => { /* the cookie is going regardless */ });
  }
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}

module.exports = {
  attachAccount,
  requireAccount,
  requestCode,
  verifyCode,
  me,
  logout,
  COOKIE
};
