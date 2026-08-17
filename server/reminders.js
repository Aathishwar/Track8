/**
 * Track8 - pending reminder store and scheduler
 *
 * What lives here is deliberately tiny: for each phone with a break currently
 * running, one record saying "push this endpoint at this time". No attendance
 * data, no names, no history. A record exists for as long as a break does,
 * which is usually under an hour, and is deleted the moment the break ends.
 *
 * Records are keyed by the push endpoint, which the browser generates and which
 * is unique per device per browser. That is also what keeps phones independent:
 * there is no account, nothing joins two endpoints together, and the server
 * cannot tell that two records belong to the same person.
 *
 * Persistence is a JSON file rewritten on change. On Render's free tier the
 * disk does not survive a restart, which is an accepted trade: a reminder is
 * short-lived, the cron ping makes restarts rare, and the app re-registers its
 * open break every time it is opened or brought to the foreground.
 */
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const quips = require('./quips');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'reminders.json');

// Stop nagging eventually. If someone ends a break while offline, the cancel
// never reaches us, and without this the server would push every few minutes
// for the rest of time.
const MAX_PUSHES = 24;
const MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;

// Consecutive send failures before a subscription is retired. Enough to ride
// out a brief push-service outage, few enough that a permanently broken
// endpoint is not retried for hours.
const MAX_FAILURES = 3;

// This endpoint is public, so it is worth a ceiling. Far above any real use of
// a personal tracker.
const MAX_RECORDS = 5000;

const TICK_MS = 20 * 1000;

/** endpoint -> record */
const pending = new Map();
let writeTimer = null;

/* ------------------------------------------------------------- persistence */

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    const now = Date.now();
    list.forEach((record) => {
      // Drop anything that expired while we were down rather than firing a
      // burst of stale reminders on boot.
      if (!record || !record.subscription || record.startedAt + MAX_LIFETIME_MS < now) return;
      pending.set(record.subscription.endpoint, record);
    });
    console.log(`[reminders] restored ${pending.size} pending`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[reminders] could not read store:', e.message);
  }
}

/** Debounced: a burst of registrations should cost one write, not ten. */
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...pending.values()]));
    } catch (e) {
      // Losing the file costs at most the reminders for breaks running right
      // now, and only if the process also dies. Not worth crashing over.
      console.warn('[reminders] could not write store:', e.message);
    }
  }, 500);
}

/* ---------------------------------------------------------------- mutation */

function add(record) {
  if (!pending.has(record.subscription.endpoint) && pending.size >= MAX_RECORDS) {
    throw new Error('too many pending reminders');
  }
  pending.set(record.subscription.endpoint, record);
  persist();
}

function remove(endpoint) {
  const existed = pending.delete(endpoint);
  if (existed) persist();
  return existed;
}

function size() {
  return pending.size;
}

/* ----------------------------------------------------------------- sending */

function minutesSince(startedAt, now) {
  return Math.max(0, Math.floor((now - startedAt) / 60000));
}

/**
 * Wording matches the in-app reminder, so the same break does not describe
 * itself two different ways depending on which layer got there first.
 */
function payloadFor(record, now) {
  const minutes = minutesSince(record.startedAt, now);
  const label = record.kind === 'LUNCH' ? 'Lunch' : 'Break';
  const lower = label.toLowerCase();
  const icon = record.kind === 'LUNCH' ? '🍱' : '☕';
  const over = minutes - record.firstMinutes;

  const facts = record.pushCount === 0
    ? `You passed your ${record.firstMinutes} min ${lower}. Tap "End ${lower}" to get back on the clock.`
    : `${over} min over your ${record.firstMinutes} min limit. Still on ${lower} - this time is not counting towards your goal.`;

  // Empty unless PUSH_QUIPS is set. When it is, the quip leads and the facts
  // follow, same as the in-app reminder - and it is read from an in-memory
  // pool, so nothing here can delay a send.
  const quip = quips.line(record.kind, over);

  return {
    title: `${icon} ${label} running ${minutes} min`,
    body: quip ? `${quip} ${facts}` : facts,
    actionTitle: `End ${lower}`
  };
}

async function sendOne(record, now) {
  try {
    await webpush.sendNotification(
      record.subscription,
      JSON.stringify(payloadFor(record, now))
    );
    return { ok: true };
  } catch (e) {
    // 404 and 410 mean the browser has thrown the subscription away - the app
    // was uninstalled, or the user cleared site data. Keeping it would mean
    // failing forever.
    const gone = e.statusCode === 404 || e.statusCode === 410;
    return { ok: false, gone, status: e.statusCode, message: e.message };
  }
}

/**
 * One pass over everything that is due.
 *
 * Due times are recomputed from the moment the break started rather than
 * accumulated, matching the rule the client follows: a tick that arrives late,
 * after a restart or a slow send, fires what was owed and no duplicates.
 */
async function tick() {
  const now = Date.now();
  const due = [...pending.values()].filter((r) => r.dueAt <= now);
  if (!due.length) return;

  for (const record of due) {
    if (record.startedAt + MAX_LIFETIME_MS < now || record.pushCount >= MAX_PUSHES) {
      remove(record.subscription.endpoint);
      continue;
    }

    const result = await sendOne(record, now);

    if (!result.ok) {
      // 404/410 is the push service saying the subscription is gone. Anything
      // else can be a passing outage - but it can equally be a permanent
      // rejection that does not use those codes, such as the 400 a malformed
      // key earns. Retrying either forever is wrong, so a few consecutive
      // failures retire the record and the phone re-registers on next open.
      record.failures = (record.failures || 0) + 1;
      if (result.gone || record.failures >= MAX_FAILURES) {
        console.warn('[reminders] dropping subscription after ' + record.failures +
          ' failure(s), status ' + result.status);
        remove(record.subscription.endpoint);
        continue;
      }
    } else {
      record.failures = 0;
      record.pushCount += 1;
    }

    record.dueAt = now + record.repeatMinutes * 60000;
    persist();
  }
}

function startScheduler() {
  setInterval(() => {
    tick().catch((e) => console.error('[reminders] tick failed:', e.message));
    // Rate limited to a few hours inside quips itself, and never awaited: the
    // reminder pass must not wait on a model, ever.
    quips.refresh();
  }, TICK_MS);
}

module.exports = { load, add, remove, size, startScheduler, MAX_PUSHES };
