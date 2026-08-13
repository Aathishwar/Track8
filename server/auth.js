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

/**
 * Issue and send a code for an address, with the rate limits applied.
 *
 * Shared by signing in and by changing an account's email. Both are the same
 * question - can you receive mail at this address - so they use the same
 * machinery. Returns a status and message for the caller to send on, rather
 * than writing the response itself.
 */
async function issueCode(req, email) {
  if (!ipAllowed(clientIp(req))) {
    return { status: 429, body: { error: 'too many requests, try again later' } };
  }

  const { rows } = await db.query('select * from login_codes where email = $1', [email]);
  const existing = rows[0];

  if (existing) {
    const sinceSent = Date.now() - new Date(existing.sent_at).getTime();
    if (sinceSent < RESEND_COOLDOWN_MS) {
      return {
        status: 429,
        body: {
          error: 'a code was just sent, check your inbox',
          retryInSeconds: Math.ceil((RESEND_COOLDOWN_MS - sinceSent) / 1000)
        }
      };
    }
    if (sinceSent < 60 * 60 * 1000 && existing.sent_count >= MAX_SENDS_PER_HOUR) {
      return { status: 429, body: { error: 'too many codes requested, try again in an hour' } };
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
    return { status: 502, body: { error: 'could not send the email, try again in a moment' } };
  }

  return { status: 200, body: { ok: true, expiresInSeconds: CODE_TTL_MS / 1000 } };
}

/**
 * Check a code for an address and consume it.
 *
 * Every rejection reads the same, so nothing can be learned by probing which
 * of "never asked", "expired", "used up" or "wrong" applies.
 */
async function consumeCode(email, code) {
  const { rows } = await db.query('select * from login_codes where email = $1', [email]);
  const record = rows[0];
  if (!record) return false;

  if (new Date(record.expires_at).getTime() < Date.now() || record.attempts >= MAX_ATTEMPTS) {
    await db.query('delete from login_codes where email = $1', [email]);
    return false;
  }

  if (!safeEqual(sha256(code), record.code_hash)) {
    if (record.attempts + 1 >= MAX_ATTEMPTS) {
      await db.query('delete from login_codes where email = $1', [email]);
    } else {
      await db.query('update login_codes set attempts = attempts + 1 where email = $1', [email]);
    }
    return false;
  }

  await db.query('delete from login_codes where email = $1', [email]);
  return true;
}

async function requestCode(req, res) {
  if (!db.configured()) return res.status(503).json({ error: 'sync not configured' });

  const email = normaliseEmail((req.body || {}).email);
  if (!validEmail(email)) return res.status(400).json({ error: 'enter a valid email address' });

  try {
    const result = await issueCode(req, email);
    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error('[auth] requestCode failed:', e.message);
    return res.status(500).json({ error: 'something went wrong, try again' });
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
    const accepted = await consumeCode(email, code);
    if (!accepted) return res.status(400).json({ error: 'that code is wrong or has expired' });

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

/* ---------------------------------------------------------- change email */

/**
 * Send a code to the address the user wants to move to.
 *
 * Two proofs are required to complete the change, and they are checked in
 * different places: the session cookie proves which account is asking, and the
 * code proves control of the destination address. Neither alone is enough,
 * which is why the code goes to the new address rather than the current one.
 */
async function requestEmailChange(req, res) {
  if (!db.configured()) return res.status(503).json({ error: 'sync not configured' });

  const email = normaliseEmail((req.body || {}).email);
  if (!validEmail(email)) return res.status(400).json({ error: 'enter a valid email address' });
  if (email === normaliseEmail(req.account.email)) {
    return res.status(400).json({ error: 'that is already your email' });
  }

  try {
    // Refused rather than merged. Two accounts cannot share an address, and
    // silently folding one into the other would be a data loss nobody asked
    // for.
    const taken = await db.query('select 1 from accounts where email = $1', [email]);
    if (taken.rows.length) {
      return res.status(409).json({ error: 'that email already has a Track8 account' });
    }

    const result = await issueCode(req, email);
    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error('[auth] requestEmailChange failed:', e.message);
    return res.status(500).json({ error: 'something went wrong, try again' });
  }
}

async function confirmEmailChange(req, res) {
  if (!db.configured()) return res.status(503).json({ error: 'sync not configured' });

  const email = normaliseEmail((req.body || {}).email);
  const code = String((req.body || {}).code || '').trim();

  if (!validEmail(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'enter the 6-digit code' });
  }
  if (email === normaliseEmail(req.account.email)) {
    return res.status(400).json({ error: 'that is already your email' });
  }

  try {
    const accepted = await consumeCode(email, code);
    if (!accepted) return res.status(400).json({ error: 'that code is wrong or has expired' });

    // Re-checked after the code was consumed: the address could have been
    // claimed in the ten minutes the code was valid for.
    const taken = await db.query('select 1 from accounts where email = $1', [email]);
    if (taken.rows.length) {
      return res.status(409).json({ error: 'that email already has a Track8 account' });
    }

    await db.query('update accounts set email = $1 where id = $2', [email, req.account.id]);

    // Sessions are keyed to the account, not the address, so every signed-in
    // device stays signed in - nothing about who they are has changed.
    res.json({ ok: true, email });
  } catch (e) {
    console.error('[auth] confirmEmailChange failed:', e.message);
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
  requestEmailChange,
  confirmEmailChange,
  me,
  logout,
  COOKIE
};
