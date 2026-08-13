/**
 * Track8 - database
 *
 * Postgres holds accounts, sessions and the synced day logs. The phone remains
 * the working copy; this is the durable one, so that clearing a browser or
 * moving to a new device does not lose a year of hours.
 *
 * Isolation is the thing to get right here, because getting it wrong shows one
 * person's attendance to another. Two independent defences:
 *
 *   1. Every data query takes an account id and filters on it. The id comes
 *      from the session cookie and is never read from a request body.
 *   2. Row-level security on the tables that hold attendance, forced on so it
 *      applies to the table owner too. A query that forgets its WHERE returns
 *      nothing instead of returning everyone's rows.
 *
 * The second exists because the first is a promise a human has to keep on
 * every future query, and humans forget.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon terminates TLS at the pooler with a certificate chain node does not
  // ship a root for; the connection is still encrypted.
  ssl: process.env.DATABASE_URL && /neon\.tech|render\.com|amazonaws/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 30000,
  // Neon suspends idle compute and the first connection has to wake it.
  connectionTimeoutMillis: 15000
});

pool.on('error', (e) => console.error('[db] idle client error:', e.message));

const configured = Boolean(process.env.DATABASE_URL);

/* ----------------------------------------------------------------- schema */

// Profiles carry a surrogate key rather than reusing the client's own person
// id as a primary key. Those ids are generated on the phone from a timestamp
// and a random suffix, so two accounts could in principle mint the same one -
// and a collision on a shared primary key is a cross-account data leak. The
// client id is unique per account instead, which makes a collision harmless.
const SCHEMA = `
create table if not exists accounts (
  id          bigserial primary key,
  email       text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists login_codes (
  email       text primary key,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  sent_at     timestamptz not null default now(),
  sent_count  int not null default 1
);

create table if not exists sessions (
  token_hash   text primary key,
  account_id   bigint not null references accounts(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index if not exists sessions_account_idx on sessions(account_id);

-- updated_at is the client's own timestamp and decides last-write-wins.
-- synced_at is server time and is what delta queries use. They have to be
-- separate: two phones with clocks a few minutes apart would otherwise skip
-- each other's changes, because "everything newer than my last sync" would be
-- measured against a clock that is not the one that wrote the row.
create table if not exists profiles (
  id          bigserial primary key,
  account_id  bigint not null references accounts(id) on delete cascade,
  client_id   text not null,
  name        text not null,
  role        text not null default '',
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now(),
  synced_at   timestamptz not null default now(),
  unique (account_id, client_id)
);
create index if not exists profiles_account_idx on profiles(account_id);
create index if not exists profiles_synced_idx on profiles(account_id, synced_at);

create table if not exists days (
  profile_id  bigint not null references profiles(id) on delete cascade,
  date_key    text not null,
  events      jsonb not null,
  note        text not null default '',
  deleted     boolean not null default false,
  updated_at  timestamptz not null,
  synced_at   timestamptz not null default now(),
  primary key (profile_id, date_key)
);
create index if not exists days_synced_idx on days(profile_id, synced_at);

create table if not exists account_settings (
  account_id  bigint primary key references accounts(id) on delete cascade,
  settings    jsonb not null,
  updated_at  timestamptz not null,
  synced_at   timestamptz not null default now()
);

-- A day that lost a last-write-wins race is kept rather than dropped, so a
-- correction made on two devices at once is recoverable.
create table if not exists conflicts (
  id           bigserial primary key,
  profile_id   bigint not null references profiles(id) on delete cascade,
  date_key     text not null,
  events       jsonb not null,
  note         text not null default '',
  updated_at   timestamptz not null,
  recorded_at  timestamptz not null default now()
);
`;

// Row-level security is ignored for any role holding BYPASSRLS, and Neon's
// default owner role holds exactly that - so enabling policies while connected
// as the owner produces a second wall that is not there. Verified: with the
// owner, an unscoped `select count(*) from days` returned every account's rows
// despite the policies being present and forced.
//
// The fix needs no extra connection string. A role is created that cannot
// bypass anything, and each account transaction switches into it. `set local
// role` is scoped to the transaction, so it cannot leak into the next request
// that borrows the same pooled connection, and it reverts on commit.
const APP_ROLE = 'track8_app';

const ROLE_SETUP = [
  `do $$
   begin
     if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
       create role ${APP_ROLE} nologin nobypassrls;
     end if;
   end $$`,
  `alter role ${APP_ROLE} nobypassrls`,
  // Creating a role does not make you a member of it, and `set local role`
  // requires membership. Without this the switch fails with "permission denied
  // to set role" and every sync returns 500.
  `do $$ begin execute format('grant %I to %I', '${APP_ROLE}', current_user); end $$`,
  `grant usage on schema public to ${APP_ROLE}`,
  `grant select, insert, update, delete on all tables in schema public to ${APP_ROLE}`,
  `grant usage, select on all sequences in schema public to ${APP_ROLE}`
];

// Applied separately: these are idempotent but not `if not exists`, so each is
// allowed to fail without taking the boot down.
const RLS = [
  `alter table profiles enable row level security`,
  `alter table profiles force row level security`,
  `alter table days enable row level security`,
  `alter table days force row level security`,
  `alter table account_settings enable row level security`,
  `alter table account_settings force row level security`,
  // Both halves are needed. `using` decides which existing rows are visible to
  // select, update and delete; `with check` decides which rows may be written.
  // A policy with only `using` silently forbids every insert, because nothing
  // permits the new row - which looks like a broken server rather than a
  // security control.
  `drop policy if exists profiles_isolation on profiles`,
  `create policy profiles_isolation on profiles
     using (account_id = nullif(current_setting('app.account_id', true), '')::bigint)
     with check (account_id = nullif(current_setting('app.account_id', true), '')::bigint)`,
  `drop policy if exists days_isolation on days`,
  `create policy days_isolation on days
     using (profile_id in (
       select id from profiles
       where account_id = nullif(current_setting('app.account_id', true), '')::bigint))
     with check (profile_id in (
       select id from profiles
       where account_id = nullif(current_setting('app.account_id', true), '')::bigint))`,
  `drop policy if exists settings_isolation on account_settings`,
  `create policy settings_isolation on account_settings
     using (account_id = nullif(current_setting('app.account_id', true), '')::bigint)
     with check (account_id = nullif(current_setting('app.account_id', true), '')::bigint)`,
  // Conflicts are written while acting as the restricted role too.
  `alter table conflicts enable row level security`,
  `alter table conflicts force row level security`,
  `drop policy if exists conflicts_isolation on conflicts`,
  `create policy conflicts_isolation on conflicts
     using (profile_id in (
       select id from profiles
       where account_id = nullif(current_setting('app.account_id', true), '')::bigint))
     with check (profile_id in (
       select id from profiles
       where account_id = nullif(current_setting('app.account_id', true), '')::bigint))`
];

// False when the restricted role could not be created, which means row-level
// security is not actually enforcing anything. Queries still scope by account
// themselves, but the second wall is missing and that should be said out loud
// rather than assumed.
let roleReady = false;

async function init() {
  if (!configured) {
    console.warn('[db] DATABASE_URL missing - sync disabled, the app still works offline-only.');
    return false;
  }

  await pool.query(SCHEMA);

  try {
    for (const statement of ROLE_SETUP) await pool.query(statement);
    roleReady = true;
  } catch (e) {
    console.error('[db] could not create the restricted role, row-level security will NOT be ' +
      'enforced. Queries still filter by account. Reason:', e.message);
  }

  for (const statement of RLS) {
    try {
      await pool.query(statement);
    } catch (e) {
      console.warn('[db] could not apply policy:', e.message);
    }
  }

  console.log('[db] schema ready, row-level security ' + (roleReady ? 'enforced' : 'NOT enforced'));
  return true;
}

function rlsEnforced() {
  return roleReady;
}

/* ---------------------------------------------------------------- queries */

/** For auth and anything else that legitimately spans accounts. */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run queries as one account, inside a transaction.
 *
 * `set local` scopes the setting to this transaction, which is what makes it
 * safe with a connection pooler: the value cannot leak into the next request
 * that borrows the same connection. Every row-level policy reads it, so a
 * query that forgets to filter still cannot see another account's rows.
 */
async function withAccount(accountId, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Drop the owner's BYPASSRLS privilege for the duration of this
    // transaction, so the policies actually apply to everything below.
    if (roleReady) await client.query(`set local role ${APP_ROLE}`);
    await client.query('select set_config($1, $2, true)', ['app.account_id', String(accountId)]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    try { await client.query('rollback'); } catch (_) { /* connection is going back anyway */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  init, query, withAccount, pool,
  configured: () => configured,
  rlsEnforced,
  APP_ROLE
};
