/**
 * Track8 - Store
 *
 * Owns the persisted shape of the app and every read/write to localStorage.
 * Nothing else in the codebase touches storage directly.
 *
 * Schema v2 replaces v1's accumulated second-counters with per-day event logs
 * (see timeline.js). v1 data is migrated on first load rather than discarded.
 */
(function (global) {
  'use strict';

  var TL = global.T8Timeline;

  var STORAGE_KEY = 'track8_attendance_app_v2';
  var LEGACY_KEY = 'track8_attendance_app_v1';
  var SCHEMA_VERSION = 2;

  var DEFAULT_SETTINGS = {
    dailyTargetMinutes: 480,   // 8h
    breakAlertMinutes: 15,     // first nudge after this much break
    breakRepeatMinutes: 5,     // then every this many minutes
    lunchAlertMinutes: 30,     // first nudge after this much lunch
    lunchRepeatMinutes: 5,
    notificationsEnabled: false,
    keepAliveEnabled: true,    // silent-audio trick to survive screen-off
    vibrate: true
  };

  var state = null;

  function newPersonId() {
    return 'p_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
  }

  function emptyState() {
    var id = newPersonId();
    return {
      version: SCHEMA_VERSION,
      activePersonId: id,
      persons: [{ id: id, name: 'Me', role: '', createdAt: Date.now() }],
      settings: Object.assign({}, DEFAULT_SETTINGS),
      days: (function () { var d = {}; d[id] = {}; return d; })()
    };
  }

  /**
   * Convert a v1 record into a v2 event log.
   *
   * v1 stored only totals plus punch-in/punch-out strings, so the exact
   * transition moments are gone for good. We synthesise a plausible timeline
   * anchored on the recorded punch-in that reproduces the same totals. Flagged
   * with `imported: true` so it is never mistaken for a first-hand record.
   */
  function migrateLegacyDay(legacyDay) {
    var dateKey = legacyDay.dateKey;
    if (!dateKey) return null;

    var startMs = legacyDay.punchIn
      ? new Date(legacyDay.punchIn).getTime()
      : TL.dateFromKey(dateKey).getTime() + 9 * 3600000;

    if (!isFinite(startMs)) startMs = TL.dateFromKey(dateKey).getTime() + 9 * 3600000;

    var day = TL.rebuildFromTotals(dateKey, {
      startMs: startMs,
      workMs: (legacyDay.workSeconds || 0) * 1000,
      breakMs: (legacyDay.breakSeconds || 0) * 1000,
      lunchMs: (legacyDay.lunchSeconds || 0) * 1000
    });

    day.imported = true;
    return day;
  }

  function migrateLegacyState(legacy) {
    var next = {
      version: SCHEMA_VERSION,
      activePersonId: legacy.activePersonId,
      persons: [],
      settings: Object.assign({}, DEFAULT_SETTINGS),
      days: {}
    };

    (legacy.persons || []).forEach(function (p) {
      if (!p || !p.id || !p.name) return;
      next.persons.push({ id: p.id, name: p.name, role: p.role || '', createdAt: Date.now() });
    });

    if (!next.persons.length) return null;
    if (!next.persons.some(function (p) { return p.id === next.activePersonId; })) {
      next.activePersonId = next.persons[0].id;
    }

    next.persons.forEach(function (p) {
      var legacyLogs = (legacy.logs && legacy.logs[p.id]) || {};
      var days = {};
      Object.keys(legacyLogs).forEach(function (key) {
        var day = migrateLegacyDay(legacyLogs[key]);
        if (day) days[key] = day;
      });
      next.days[p.id] = days;
    });

    return next;
  }

  /**
   * Repair anything structurally missing.
   *
   * v1 parsed stored JSON straight into the live state, so one malformed blob
   * meant a blank screen with no way back. Every load now passes through here.
   */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return emptyState();

    var out = {
      version: SCHEMA_VERSION,
      activePersonId: raw.activePersonId,
      persons: Array.isArray(raw.persons) ? raw.persons.filter(function (p) {
        return p && typeof p.id === 'string' && typeof p.name === 'string';
      }) : [],
      settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {}),
      days: (raw.days && typeof raw.days === 'object') ? raw.days : {}
    };

    if (!out.persons.length) return emptyState();

    if (!out.persons.some(function (p) { return p.id === out.activePersonId; })) {
      out.activePersonId = out.persons[0].id;
    }

    out.persons.forEach(function (p) {
      var days = out.days[p.id];
      if (!days || typeof days !== 'object') {
        out.days[p.id] = {};
        return;
      }
      Object.keys(days).forEach(function (key) {
        var day = days[key];
        if (!day || !Array.isArray(day.events)) {
          delete days[key];
          return;
        }
        day.dateKey = day.dateKey || key;
        day.events = day.events
          .filter(function (ev) { return ev && typeof ev.t === 'number' && typeof ev.s === 'string'; })
          .sort(function (a, b) { return a.t - b.t; });
      });
    });

    return out;
  }

  function load() {
    var raw = null;

    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored) raw = JSON.parse(stored);
    } catch (e) {
      console.warn('Track8: stored data unreadable, starting fresh.', e);
      raw = null;
    }

    if (!raw) {
      try {
        var legacyRaw = localStorage.getItem(LEGACY_KEY);
        if (legacyRaw) {
          var migrated = migrateLegacyState(JSON.parse(legacyRaw));
          if (migrated) {
            raw = migrated;
            console.info('Track8: migrated v1 data to v2 event logs.');
          }
        }
      } catch (e) {
        console.warn('Track8: could not migrate v1 data.', e);
      }
    }

    state = normalize(raw);
    save();
    return state;
  }

  function save() {
    if (!state) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Track8: could not save. Storage may be full or blocked.', e);
    }
  }

  function get() {
    if (!state) load();
    return state;
  }

  function settings() {
    return get().settings;
  }

  function updateSettings(patch) {
    Object.assign(get().settings, patch);
    save();
  }

  function persons() {
    return get().persons;
  }

  function activePerson() {
    var s = get();
    return s.persons.find(function (p) { return p.id === s.activePersonId; }) || s.persons[0];
  }

  function setActivePerson(id) {
    var s = get();
    if (!s.persons.some(function (p) { return p.id === id; })) return false;
    s.activePersonId = id;
    save();
    return true;
  }

  function addPerson(name, role) {
    var s = get();
    var person = { id: newPersonId(), name: name, role: role || '', createdAt: Date.now() };
    s.persons.push(person);
    s.days[person.id] = {};
    s.activePersonId = person.id;
    save();
    return person;
  }

  function renamePerson(id, name, role) {
    var person = get().persons.find(function (p) { return p.id === id; });
    if (!person) return false;
    person.name = name;
    if (role != null) person.role = role;
    save();
    return true;
  }

  /** Removing the last remaining person is refused; the app needs one. */
  function removePerson(id) {
    var s = get();
    if (s.persons.length <= 1) return false;

    s.persons = s.persons.filter(function (p) { return p.id !== id; });
    delete s.days[id];
    if (s.activePersonId === id) s.activePersonId = s.persons[0].id;
    save();
    return true;
  }

  function daysOf(personId) {
    var s = get();
    var id = personId || s.activePersonId;
    if (!s.days[id]) s.days[id] = {};
    return s.days[id];
  }

  function getDay(dateKey, personId) {
    return daysOf(personId)[dateKey] || null;
  }

  function ensureDay(dateKey, personId) {
    var days = daysOf(personId);
    if (!days[dateKey]) days[dateKey] = TL.createDay(dateKey);
    return days[dateKey];
  }

  function putDay(day, personId) {
    daysOf(personId)[day.dateKey] = day;
    save();
    return day;
  }

  function deleteDay(dateKey, personId) {
    delete daysOf(personId)[dateKey];
    save();
  }

  /**
   * The most recent day that was started but never ended.
   *
   * `beforeKey` excludes that date and anything after it, which is how the
   * recovery prompt finds a forgotten shift while today is legitimately still
   * running - without it, today would always mask the stale day and the user
   * would never be asked to fix it.
   */
  function findOpenDay(personId, beforeKey) {
    var days = daysOf(personId);
    var keys = Object.keys(days).sort();
    for (var i = keys.length - 1; i >= 0; i--) {
      if (beforeKey && keys[i] >= beforeKey) continue;
      if (TL.isRunning(days[keys[i]])) return days[keys[i]];
    }
    return null;
  }

  function exportJSON() {
    return JSON.stringify(get(), null, 2);
  }

  /**
   * Restore from an exported file. Validated and normalised like any other
   * load, so a truncated or hand-edited file cannot brick the app.
   */
  function importJSON(text) {
    var parsed = JSON.parse(text);

    var candidate;
    if (parsed && parsed.version === SCHEMA_VERSION) {
      candidate = normalize(parsed);
    } else if (parsed && parsed.logs) {
      candidate = normalize(migrateLegacyState(parsed));
    } else {
      candidate = normalize(parsed);
    }

    if (!candidate.persons.length) throw new Error('No profiles found in that file.');

    state = candidate;
    save();
    return state;
  }

  global.T8Store = {
    STORAGE_KEY: STORAGE_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    load: load,
    save: save,
    get: get,
    settings: settings,
    updateSettings: updateSettings,
    persons: persons,
    activePerson: activePerson,
    setActivePerson: setActivePerson,
    addPerson: addPerson,
    renamePerson: renamePerson,
    removePerson: removePerson,
    daysOf: daysOf,
    getDay: getDay,
    ensureDay: ensureDay,
    putDay: putDay,
    deleteDay: deleteDay,
    findOpenDay: findOpenDay,
    exportJSON: exportJSON,
    importJSON: importJSON
  };
})(typeof window !== 'undefined' ? window : globalThis);
