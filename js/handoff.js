/**
 * Track8 - the handoff box between the page and the service worker
 *
 * Break and lunch can be started and ended from the notification with the app
 * closed. The worker cannot do that work itself: the day's event log lives in
 * localStorage, which belongs to a page and is not reachable from a worker at
 * all. So the worker records the tap here, with the moment it happened, and the
 * app files it into the log whenever it next runs.
 *
 * Filing it late costs nothing, because every duration in this app is derived by
 * subtracting timestamps rather than accumulated by a counter. A break that
 * ended at 14:32 and reached the log at 18:00 is the same break, to the second.
 * That is the property the whole feature rests on.
 *
 * Two stores, for the two directions:
 *
 *   pending    Taps the worker took and the app has not filed yet.
 *   snapshot   Just enough of the day - state, when it began, credited time,
 *              the two allowances - for the worker to redraw the pinned
 *              notification and to know which actions even apply. Written by
 *              the page on transitions only, never per tick, and correct for a
 *              whole break because credited time does not move during one.
 *
 * IndexedDB because it is the only store both a page and a worker can reach.
 * Every call fails soft: a browser with IndexedDB unavailable - private mode on
 * some builds, a storage eviction - leaves the app behaving exactly as it did
 * before, opening on every notification tap.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'track8-handoff';
  var DB_VERSION = 1;
  var PENDING = 'pending';
  var SNAPSHOT = 'snapshot';
  var SNAPSHOT_KEY = 'now';

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('no indexeddb'));
        return;
      }

      var request = global.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(PENDING)) {
          // autoIncrement rather than the timestamp as the key: two taps in the
          // same millisecond are unlikely but would silently overwrite, and the
          // ascending id is also the order they have to be filed in.
          db.createObjectStore(PENDING, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(SNAPSHOT)) {
          db.createObjectStore(SNAPSHOT, { keyPath: 'k' });
        }
      };

      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('open failed')); };
      request.onblocked = function () { reject(new Error('blocked')); };
    });

    // A store that cannot be opened will not open on the next call either, and
    // every caller already has a working fallback, so the failure is cached
    // rather than retried on each notification tap.
    return dbPromise;
  }

  /**
   * Run one transaction and resolve when it commits, not when the request
   * succeeds - a resolved read whose transaction later aborts is a lie.
   */
  function run(storeName, mode, work) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(storeName, mode);
        var request;

        try {
          request = work(transaction.objectStore(storeName));
        } catch (e) {
          reject(e);
          return;
        }

        transaction.oncomplete = function () { resolve(request ? request.result : null); };
        transaction.onerror = function () { reject(transaction.error || new Error('failed')); };
        transaction.onabort = function () { reject(transaction.error || new Error('aborted')); };
      });
    });
  }

  /**
   * Record a tap the worker handled.
   *
   * `t` is when the user tapped, never when this was written. Resolves null if
   * nothing could be stored, which the worker reads as "do not pretend this
   * happened" and falls back to opening the app.
   */
  function queue(action, t) {
    return run(PENDING, 'readwrite', function (store) {
      return store.add({ action: action, t: t });
    }).catch(function () { return null; });
  }

  /** Everything waiting to be filed, oldest first. */
  function pending() {
    return run(PENDING, 'readonly', function (store) {
      return store.getAll();
    }).then(function (list) {
      return (list || []).sort(function (a, b) { return a.id - b.id; });
    }).catch(function () { return []; });
  }

  function forget(ids) {
    if (!ids || !ids.length) return Promise.resolve(false);
    return run(PENDING, 'readwrite', function (store) {
      var last = null;
      for (var i = 0; i < ids.length; i++) last = store.delete(ids[i]);
      return last;
    }).then(function () { return true; }).catch(function () { return false; });
  }

  function putSnapshot(snap) {
    var record = Object.assign({ k: SNAPSHOT_KEY }, snap);
    return run(SNAPSHOT, 'readwrite', function (store) {
      return store.put(record);
    }).then(function () { return true; }).catch(function () { return false; });
  }

  function snapshot() {
    return run(SNAPSHOT, 'readonly', function (store) {
      return store.get(SNAPSHOT_KEY);
    }).then(function (record) { return record || null; }).catch(function () { return null; });
  }

  /**
   * Drop the snapshot when the day is idle or ended.
   *
   * Without this the worker would keep a description of a day that is over and
   * could act on it - "End break" on a break that finished yesterday.
   */
  function clearSnapshot() {
    return run(SNAPSHOT, 'readwrite', function (store) {
      return store.delete(SNAPSHOT_KEY);
    }).then(function () { return true; }).catch(function () { return false; });
  }

  global.T8Handoff = {
    queue: queue,
    pending: pending,
    forget: forget,
    putSnapshot: putSnapshot,
    snapshot: snapshot,
    clearSnapshot: clearSnapshot
  };
})(typeof window !== 'undefined' ? window : self);
