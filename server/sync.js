/**
 * Track8 - sync
 *
 * One endpoint, one round trip: the client posts what changed on this device
 * since its last sync and receives what changed everywhere else. Nothing here
 * is authoritative over the phone - localStorage stays the working copy, every
 * tap is written locally and returns immediately, and this runs afterwards in
 * the background. An offline phone behaves exactly as it always has.
 *
 * A day is an independent document keyed by (profile, date), which is what
 * makes this tractable. There is no cross-day invariant to preserve, so a
 * failed or partial sync leaves a coherent mixture of old and new days rather
 * than a broken record.
 *
 * Every query is scoped to the account from the session cookie. Nothing reads
 * an account or profile id from the request body: the client sends its own
 * profile ids, and they are resolved against this account's profiles only. A
 * client id belonging to somebody else simply does not resolve.
 */
const db = require('./db');

const MAX_DAYS_PER_SYNC = 2000;
const MAX_PROFILES = 50;

function toDate(value) {
  const n = Number(value);
  if (isFinite(n) && n > 0) return new Date(n);
  return new Date(0);
}

function cleanDay(day) {
  if (!day || typeof day.dateKey !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day.dateKey)) return null;
  if (!Array.isArray(day.events)) return null;
  // Keep the shape the client uses; the timeline module is the only thing that
  // interprets it, and it validates on the way in as well.
  const events = day.events
    .filter((e) => e && typeof e.t === 'number' && typeof e.s === 'string')
    .map((e) => ({ t: e.t, s: e.s }));
  return {
    dateKey: day.dateKey,
    events,
    note: typeof day.note === 'string' ? day.note.slice(0, 2000) : '',
    deleted: Boolean(day.deleted),
    updatedAt: toDate(day.updatedAt)
  };
}

async function handleSync(req, res) {
  if (!db.configured()) return res.status(503).json({ error: 'sync not configured' });

  const body = req.body || {};
  const since = toDate(body.since);
  const incomingProfiles = Array.isArray(body.profiles) ? body.profiles.slice(0, MAX_PROFILES) : [];
  const incomingDays = Array.isArray(body.days) ? body.days.slice(0, MAX_DAYS_PER_SYNC) : [];
  const accountId = req.account.id;

  try {
    const result = await db.withAccount(accountId, async (client) => {
      let conflictCount = 0;

      /* ------------------------------------------------------- profiles up */

      for (const profile of incomingProfiles) {
        if (!profile || typeof profile.clientId !== 'string' || !profile.clientId) continue;
        await client.query(
          `insert into profiles (account_id, client_id, name, role, deleted, updated_at, synced_at)
           values ($1, $2, $3, $4, $5, $6, now())
           on conflict (account_id, client_id) do update
              set name = excluded.name,
                  role = excluded.role,
                  deleted = excluded.deleted,
                  updated_at = excluded.updated_at,
                  synced_at = now()
            where excluded.updated_at > profiles.updated_at`,
          [
            accountId,
            profile.clientId.slice(0, 64),
            String(profile.name || 'Me').slice(0, 120),
            String(profile.role || '').slice(0, 120),
            Boolean(profile.deleted),
            toDate(profile.updatedAt)
          ]
        );
      }

      // Resolve this account's profiles once. A client id that is not in here
      // belongs to another account or does not exist, and its days are ignored.
      const owned = await client.query(
        'select id, client_id from profiles where account_id = $1',
        [accountId]
      );
      const idByClientId = new Map(owned.rows.map((r) => [r.client_id, r.id]));

      /* ----------------------------------------------------------- days up */

      for (const raw of incomingDays) {
        const day = cleanDay(raw);
        if (!day) continue;
        const profileId = idByClientId.get(String(raw.profileClientId || ''));
        if (!profileId) continue;

        const current = await client.query(
          'select events, note, updated_at from days where profile_id = $1 and date_key = $2',
          [profileId, day.dateKey]
        );

        if (current.rows.length) {
          const stored = current.rows[0];
          const storedAt = new Date(stored.updated_at).getTime();
          const incomingAt = day.updatedAt.getTime();

          if (incomingAt <= storedAt) {
            // The server's copy is newer. Rather than dropping what this device
            // sent, keep it - a correction made on two phones while both were
            // offline is otherwise silently destroyed.
            if (incomingAt < storedAt && JSON.stringify(stored.events) !== JSON.stringify(day.events)) {
              await client.query(
                `insert into conflicts (profile_id, date_key, events, note, updated_at)
                 values ($1, $2, $3, $4, $5)`,
                [profileId, day.dateKey, JSON.stringify(day.events), day.note, day.updatedAt]
              );
              conflictCount++;
            }
            continue;
          }

          if (JSON.stringify(stored.events) !== JSON.stringify(day.events)) {
            await client.query(
              `insert into conflicts (profile_id, date_key, events, note, updated_at)
               values ($1, $2, $3, $4, $5)`,
              [profileId, day.dateKey, JSON.stringify(stored.events), stored.note, stored.updated_at]
            );
            conflictCount++;
          }
        }

        await client.query(
          `insert into days (profile_id, date_key, events, note, deleted, updated_at, synced_at)
           values ($1, $2, $3, $4, $5, $6, now())
           on conflict (profile_id, date_key) do update
              set events = excluded.events,
                  note = excluded.note,
                  deleted = excluded.deleted,
                  updated_at = excluded.updated_at,
                  synced_at = now()
            where excluded.updated_at > days.updated_at`,
          [profileId, day.dateKey, JSON.stringify(day.events), day.note, day.deleted, day.updatedAt]
        );
      }

      /* ------------------------------------------------------- settings up */

      if (body.settings && body.settings.value && typeof body.settings.value === 'object') {
        await client.query(
          `insert into account_settings (account_id, settings, updated_at, synced_at)
           values ($1, $2, $3, now())
           on conflict (account_id) do update
              set settings = excluded.settings,
                  updated_at = excluded.updated_at,
                  synced_at = now()
            where excluded.updated_at > account_settings.updated_at`,
          [accountId, JSON.stringify(body.settings.value), toDate(body.settings.updatedAt)]
        );
      }

      /* ----------------------------------------------------------- deltas */

      // Delta queries run on synced_at, which is server time, so a device with
      // a skewed clock cannot cause another device's changes to be skipped.
      const profilesOut = await client.query(
        `select client_id, name, role, deleted, updated_at
           from profiles
          where account_id = $1 and synced_at > $2
          order by synced_at`,
        [accountId, since]
      );

      const daysOut = await client.query(
        `select p.client_id as profile_client_id, d.date_key, d.events, d.note,
                d.deleted, d.updated_at
           from days d
           join profiles p on p.id = d.profile_id
          where p.account_id = $1 and d.synced_at > $2
          order by d.synced_at
          limit $3`,
        [accountId, since, MAX_DAYS_PER_SYNC]
      );

      const settingsOut = await client.query(
        `select settings, updated_at from account_settings
          where account_id = $1 and synced_at > $2`,
        [accountId, since]
      );

      const nowRow = await client.query('select now() as now');

      return {
        now: new Date(nowRow.rows[0].now).getTime(),
        conflicts: conflictCount,
        profiles: profilesOut.rows.map((r) => ({
          clientId: r.client_id,
          name: r.name,
          role: r.role,
          deleted: r.deleted,
          updatedAt: new Date(r.updated_at).getTime()
        })),
        days: daysOut.rows.map((r) => ({
          profileClientId: r.profile_client_id,
          dateKey: r.date_key,
          events: r.events,
          note: r.note,
          deleted: r.deleted,
          updatedAt: new Date(r.updated_at).getTime()
        })),
        settings: settingsOut.rows.length
          ? {
            value: settingsOut.rows[0].settings,
            updatedAt: new Date(settingsOut.rows[0].updated_at).getTime()
          }
          : null
      };
    });

    res.json(result);
  } catch (e) {
    console.error('[sync] failed:', e.message);
    res.status(500).json({ error: 'sync failed' });
  }
}

module.exports = { handleSync };
