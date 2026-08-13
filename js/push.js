/**
 * Track8 - server reminders (layer 0)
 *
 * The three existing reminder layers all run on the phone, which is why the
 * strongest of them can be switched off by the phone. This one does not: the
 * server holds "wake this device at 1:45" and sends it whether or not anything
 * of ours is still alive. Nothing has to stay awake, so no battery manager can
 * interfere.
 *
 * It is an addition, never a replacement. Every call here fails soft: no
 * network, no server, no push support, an older iPhone - all of them leave the
 * app behaving exactly as it did before, on its own layers. The app must stay
 * deployable to a plain static host, so "the API is not there" is a normal
 * state, not an error.
 *
 * What leaves the device is one push endpoint the browser generated, the
 * moment a break started, and how long the allowance is. No name, no hours, no
 * history. The endpoint is unique per device and per browser and is not tied to
 * anything else, so two phones running Track8 remain unrelated to the server.
 */
(function (global) {
  'use strict';

  var registration = null;
  var publicKey = null;
  var subscription = null;

  // Null until we have asked. Once false, we stop retrying for the session:
  // a static host answers every /api call with the app's own HTML, and there
  // is no point paying for that round trip on each break.
  var available = null;

  var lastError = '';

  /* -------------------------------------------------------------- helpers */

  /** VAPID keys travel as base64url; subscribe() wants raw bytes. */
  function urlBase64ToUint8Array(base64) {
    var padding = '='.repeat((4 - (base64.length % 4)) % 4);
    var normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = global.atob(normalised);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function supported() {
    return !!(global.PushManager && global.navigator && navigator.serviceWorker);
  }

  /**
   * A static host answers /api/vapid-key with index.html and a cheerful 200,
   * so a 200 is not enough - the body has to be the JSON we asked for.
   */
  function fetchJson(url, options) {
    return fetch(url, options).then(function (response) {
      if (!response.ok) throw new Error('http ' + response.status);
      var type = response.headers.get('content-type') || '';
      if (type.indexOf('application/json') === -1) throw new Error('not an api');
      return response.json();
    });
  }

  /* ----------------------------------------------------------------- setup */

  /**
   * Ask the server for its public key and subscribe this device.
   *
   * Safe to call repeatedly; the browser returns the existing subscription
   * rather than minting a new one. Requires notification permission to already
   * be granted - subscribing would otherwise trigger a permission prompt at an
   * arbitrary moment, which is the app's decision to make, not this module's.
   */
  function connect(swRegistration) {
    registration = swRegistration || registration;

    if (available === false) return Promise.resolve(false);
    if (!supported() || !registration || !registration.pushManager) {
      available = false;
      lastError = 'this browser cannot receive push';
      return Promise.resolve(false);
    }
    if (!global.T8Notify.granted()) {
      lastError = 'notifications are not allowed yet';
      return Promise.resolve(false);
    }
    if (subscription) return Promise.resolve(true);

    return fetchJson('./api/vapid-key')
      .then(function (data) {
        if (!data || !data.key) throw new Error('no key');
        publicKey = data.key;
        return registration.pushManager.getSubscription();
      })
      .then(function (existing) {
        if (existing) return existing;
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      })
      .then(function (sub) {
        subscription = sub;
        available = true;
        lastError = '';
        return true;
      })
      .catch(function (e) {
        available = false;
        lastError = e.message || 'unavailable';
        console.info('Track8: server reminders unavailable, using on-device reminders.', e);
        return false;
      });
  }

  /* ------------------------------------------------------------- reminders */

  /**
   * Tell the server when this break is due.
   *
   * `startedAt` is the timestamp the break began, not "now", so a reminder
   * registered late - on reopening the app mid-break - is still due at the
   * right moment rather than the allowance restarting.
   */
  function arm(kind, startedAt, firstMinutes, repeatMinutes) {
    return connect().then(function (ready) {
      if (!ready) return false;
      return fetchJson('./api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          kind: kind,
          startedAt: startedAt,
          firstMinutes: firstMinutes,
          repeatMinutes: repeatMinutes
        })
      }).then(function () { return true; });
    }).catch(function (e) {
      lastError = e.message || 'could not register';
      return false;
    });
  }

  /**
   * Cancel this device's reminder.
   *
   * Called when a break ends, and on every open with nothing running, because
   * a break ended while offline never reached the server and would otherwise
   * keep nagging until the server's own cap stopped it.
   */
  function disarm() {
    if (!subscription || available === false) return Promise.resolve(false);
    return fetchJson('./api/reminders', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint })
    }).then(function () { return true; })
      .catch(function () { return false; });
  }

  function status() {
    return {
      supported: supported(),
      active: available === true && !!subscription,
      checked: available !== null,
      error: lastError
    };
  }

  global.T8Push = {
    connect: connect,
    arm: arm,
    disarm: disarm,
    status: status
  };
})(typeof window !== 'undefined' ? window : globalThis);
