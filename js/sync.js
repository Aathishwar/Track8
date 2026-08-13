/**
 * Track8 - account and sync
 *
 * The phone is still the working copy. Every tap writes to localStorage and
 * returns immediately; nothing in the app ever waits on this module. Sync is a
 * background reconciliation that runs when there is a network and is simply
 * skipped when there is not, which is why the app behaves identically offline.
 *
 * Sign-in is an emailed six-digit code. There is no signup: an address becomes
 * an account the first time it proves it can receive a code.
 *
 * What travels: day event logs, profile names, settings. Days are independent
 * documents keyed by profile and date, so a partial sync leaves a coherent
 * mixture of old and new days rather than a broken record.
 */
(function (global) {
  'use strict';

  var Store = global.T8Store;

  var LAST_SYNC_KEY = 'track8_last_sync_v1';

  var account = null;          // { email } once signed in
  var syncAvailable = null;    // null until the server has been asked
  var running = false;
  var queued = false;
  var listeners = [];

  var lastResult = { at: 0, ok: null, error: '', conflicts: 0 };

  /* ---------------------------------------------------------------- helpers */

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(status()); } catch (e) { /* a broken listener is not our problem */ }
    });
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  function lastSyncedAt() {
    return Number(localStorage.getItem(LAST_SYNC_KEY) || 0);
  }

  function setLastSyncedAt(value) {
    localStorage.setItem(LAST_SYNC_KEY, String(value));
  }

  /**
   * A static host answers every path with index.html and a 200, so a 200 is
   * not evidence that a server is there. Only JSON is.
   */
  function api(path, options) {
    var config = options || {};
    config.credentials = 'same-origin';
    if (config.body) {
      config.headers = config.headers || {};
      config.headers['Content-Type'] = 'application/json';
    }
    return fetch(path, config).then(function (response) {
      var type = response.headers.get('content-type') || '';
      if (type.indexOf('application/json') === -1) throw new Error('no api');
      return response.json().then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || ('http ' + response.status));
          error.status = response.status;
          error.data = data;
          throw error;
        }
        return data;
      });
    });
  }

  /* ------------------------------------------------------------------ auth */

  /** Ask the server who we are. Called once at boot. */
  function refresh() {
    return api('./api/auth/me')
      .then(function (data) {
        syncAvailable = !!data.syncAvailable;
        account = data.signedIn ? { email: data.email } : null;
        notify();
        return data;
      })
      .catch(function () {
        // No server, no network, or a static host. Either way the app runs
        // exactly as it did before accounts existed.
        syncAvailable = false;
        account = null;
        notify();
        return { signedIn: false, syncAvailable: false };
      });
  }

  function requestCode(email) {
    return api('./api/auth/request-code', {
      method: 'POST',
      body: JSON.stringify({ email: email })
    });
  }

  function verifyCode(email, code) {
    return api('./api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ email: email, code: code })
    }).then(function (data) {
      account = { email: data.email };
      // A fresh account starts from zero so this device's existing history is
      // uploaded rather than being mistaken for already-synced.
      setLastSyncedAt(0);
      notify();
      return data;
    });
  }

  /* ---------------------------------------------------------- change email */

  function requestEmailChange(email) {
    return api('./api/account/email/request', {
      method: 'POST',
      body: JSON.stringify({ email: email })
    });
  }

  function confirmEmailChange(email, code) {
    return api('./api/account/email/confirm', {
      method: 'POST',
      body: JSON.stringify({ email: email, code: code })
    }).then(function (data) {
      account = { email: data.email };
      notify();
      return data;
    });
  }

  function signOut() {
    return api('./api/auth/logout', { method: 'POST' })
      .catch(function () { /* clearing locally is what matters */ })
      .then(function () {
        account = null;
        setLastSyncedAt(0);
        notify();
      });
  }

  /* ------------------------------------------------------ gathering changes */

  /**
   * Everything this device has touched since the last successful sync.
   *
   * Days with no `updatedAt` predate sync entirely. They are stamped with their
   * own last event rather than with "now", so an old day from a phone that is
   * barely used cannot outrank a newer version of the same day from the device
   * actually in use.
   */
  // What store.js names the profile it creates on a device that has never been
  // used. Untouched, it is not a person - it is an empty slot.
  var DEFAULT_PROFILE_NAME = 'Me';

  /**
   * A starter profile nobody has used yet.
   *
   * Every device mints its own person id, so signing in on a second device
   * would otherwise upload its empty "Me" as a second person and leave the
   * account with one profile per device. Uploading is skipped for these, and
   * applyServerChanges() retires them once the account's real profile arrives.
   */
  function isUntouchedDefault(state, person) {
    if (!person || person.name !== DEFAULT_PROFILE_NAME) return false;
    if (person.role) return false;
    var days = state.days[person.id] || {};
    return Object.keys(days).length === 0;
  }

  function localChanges(since) {
    var state = Store.get();
    var days = [];
    var profiles = [];

    state.persons.forEach(function (person) {
      // Nothing to say about an empty slot. If this turns out to be a brand
      // new account it stays local, gets named, and is uploaded then.
      if (isUntouchedDefault(state, person)) return;

      var updatedAt = person.updatedAt || person.createdAt || 1;
      if (updatedAt > since) {
        profiles.push({
          clientId: person.id,
          name: person.name,
          role: person.role || '',
          deleted: false,
          updatedAt: updatedAt
        });
      }

      var byDate = state.days[person.id] || {};
      Object.keys(byDate).forEach(function (dateKey) {
        var day = byDate[dateKey];
        if (!day) return;

        var stamp = day.updatedAt;
        if (!stamp) {
          var last = day.events && day.events.length ? day.events[day.events.length - 1].t : 0;
          stamp = last || 1;
          day.updatedAt = stamp;
        }
        if (stamp <= since) return;

        days.push({
          profileClientId: person.id,
          dateKey: dateKey,
          events: day.events || [],
          note: day.note || '',
          deleted: !!day.deleted,
          updatedAt: stamp
        });
      });
    });

    Object.keys(state.deletedPersons || {}).forEach(function (id) {
      var tomb = state.deletedPersons[id];
      if (tomb.updatedAt > since) {
        profiles.push({
          clientId: id, name: tomb.name, role: tomb.role,
          deleted: true, updatedAt: tomb.updatedAt
        });
      }
    });

    var settings = null;
    if ((state.settingsUpdatedAt || 0) > since) {
      settings = { value: state.settings, updatedAt: state.settingsUpdatedAt };
    }

    return { profiles: profiles, days: days, settings: settings };
  }

  /* ------------------------------------------------------- applying changes */

  function applyServerChanges(data) {
    var state = Store.get();
    var changed = false;

    (data.profiles || []).forEach(function (incoming) {
      if (incoming.deleted) {
        var before = state.persons.length;
        state.persons = state.persons.filter(function (p) { return p.id !== incoming.clientId; });
        delete state.days[incoming.clientId];
        if (state.persons.length !== before) changed = true;
        return;
      }

      var person = state.persons.find(function (p) { return p.id === incoming.clientId; });
      if (!person) {
        state.persons.push({
          id: incoming.clientId, name: incoming.name, role: incoming.role,
          createdAt: incoming.updatedAt, updatedAt: incoming.updatedAt
        });
        state.days[incoming.clientId] = state.days[incoming.clientId] || {};
        changed = true;
      } else if ((incoming.updatedAt || 0) > (person.updatedAt || 0)) {
        person.name = incoming.name;
        person.role = incoming.role;
        person.updatedAt = incoming.updatedAt;
        changed = true;
      }
    });

    (data.days || []).forEach(function (incoming) {
      if (!state.days[incoming.profileClientId]) state.days[incoming.profileClientId] = {};
      var bucket = state.days[incoming.profileClientId];
      var existing = bucket[incoming.dateKey];

      // Last write wins, and the server already applied the same rule, so this
      // only matters for a day edited locally while the response was in flight.
      if (existing && (existing.updatedAt || 0) >= (incoming.updatedAt || 0)) return;

      bucket[incoming.dateKey] = {
        dateKey: incoming.dateKey,
        events: incoming.events || [],
        note: incoming.note || '',
        deleted: !!incoming.deleted,
        updatedAt: incoming.updatedAt
      };
      changed = true;
    });

    if (data.settings && data.settings.value) {
      if ((data.settings.updatedAt || 0) > (state.settingsUpdatedAt || 0)) {
        Object.assign(state.settings, data.settings.value);
        state.settingsUpdatedAt = data.settings.updatedAt;
        changed = true;
      }
    }

    // Retire the empty starter profile once the account's real one has
    // arrived. Without this, signing in on a new device leaves you looking at
    // two people - the account's, and the placeholder this device happened to
    // create before it knew who you were. Removed outright rather than
    // tombstoned, because it was never uploaded and so does not exist anywhere
    // else to delete.
    // Only a placeholder the server has never heard of. A profile genuinely
    // named "Me" on the account is somebody's actual profile: retiring that
    // would delete it here and then pull it straight back on the next full
    // sync, flickering forever.
    var known = {};
    (data.profiles || []).forEach(function (p) { known[p.clientId] = true; });

    var retired = state.persons.filter(function (p) {
      return isUntouchedDefault(state, p) && !known[p.id];
    });
    var keep = state.persons.filter(function (p) { return retired.indexOf(p) === -1; });

    if (retired.length && keep.length) {
      retired.forEach(function (p) { delete state.days[p.id]; });
      state.persons = keep;
      if (retired.some(function (p) { return p.id === state.activePersonId; })) {
        state.activePersonId = keep[0].id;
      }
      changed = true;
    }

    // The active profile may have been removed on another device.
    if (!state.persons.some(function (p) { return p.id === state.activePersonId; })) {
      if (state.persons.length) state.activePersonId = state.persons[0].id;
    }

    if (changed) Store.save();
    return changed;
  }

  /* ------------------------------------------------------------------ sync */

  /**
   * Push local changes, pull remote ones.
   *
   * Never rejects and never blocks the UI. A failure leaves `lastSyncedAt`
   * untouched, so the same changes are simply offered again next time - which
   * is what makes an unreliable connection harmless.
   */
  function run(reason) {
    if (!account || syncAvailable === false) return Promise.resolve(false);
    if (!navigator.onLine) return Promise.resolve(false);

    // One at a time. A second request while the first is in flight would race
    // on lastSyncedAt and could skip changes.
    if (running) {
      queued = true;
      return Promise.resolve(false);
    }
    running = true;

    var since = lastSyncedAt();
    var payload = localChanges(since);
    payload.since = since;

    return api('./api/sync', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (data) {
        var changed = applyServerChanges(data);
        setLastSyncedAt(data.now);
        lastResult = { at: Date.now(), ok: true, error: '', conflicts: data.conflicts || 0 };
        notify();
        if (changed && global.T8App && global.T8App.onSyncApplied) global.T8App.onSyncApplied();
        return changed;
      })
      .catch(function (e) {
        if (e.status === 401) {
          account = null;   // session expired; the sign-in screen takes over
          notify();
        }
        lastResult = { at: Date.now(), ok: false, error: e.message || 'sync failed', conflicts: 0 };
        notify();
        return false;
      })
      .then(function (result) {
        running = false;
        if (queued) {
          queued = false;
          setTimeout(function () { run('queued'); }, 400);
        }
        return result;
      });
  }

  var debounceTimer = null;

  /** Coalesce the burst of calls a single user action can produce. */
  function schedule(reason, delay) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { run(reason); }, delay == null ? 1500 : delay);
  }

  function status() {
    return {
      available: syncAvailable === true,
      checked: syncAvailable !== null,
      signedIn: !!account,
      email: account ? account.email : null,
      online: navigator.onLine,
      lastSyncAt: lastResult.at,
      lastSyncOk: lastResult.ok,
      error: lastResult.error,
      conflicts: lastResult.conflicts
    };
  }

  function init() {
    global.addEventListener('online', function () { run('online'); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') schedule('visible', 300);
    });
    return refresh().then(function (data) {
      if (data.signedIn) run('boot');
      return data;
    });
  }

  global.T8Sync = {
    init: init,
    refresh: refresh,
    requestCode: requestCode,
    verifyCode: verifyCode,
    requestEmailChange: requestEmailChange,
    confirmEmailChange: confirmEmailChange,
    signOut: signOut,
    run: run,
    schedule: schedule,
    status: status,
    onChange: onChange,

    // Exposed for verification, like the other modules: these two are pure
    // enough to drive directly, which is how the profile-merge rules are
    // tested against a real server without a browser.
    localChanges: localChanges,
    applyServerChanges: applyServerChanges
  };
})(typeof window !== 'undefined' ? window : globalThis);
