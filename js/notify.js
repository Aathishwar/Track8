/**
 * Track8 - Reminder engine
 *
 * Goal: the user starts a break, locks the phone, and is reminded to come back
 * even though nothing of ours is on screen. No web app can guarantee that
 * without a push server, so the reminder is delivered in three layers and the
 * weakest one failing never costs the user the reminder entirely.
 *
 *   Layer 1  Ongoing notification, posted the moment a break starts and pinned
 *            in the shade until the break ends. Carries an "End break" action
 *            so the break can be closed without opening the app. Costs nothing
 *            to keep alive and works on every browser that supports
 *            notifications at all.
 *
 *   Layer 2  Live nagging at breakAlertMinutes, then every breakRepeatMinutes.
 *            Needs our timers to keep running while the screen is off, which
 *            Android only permits for pages playing audio - hence the silent
 *            keep-alive track. Best effort: aggressive OEM battery managers
 *            and iOS both suspend it.
 *
 *   Layer 3  Catch-up. Whenever the page becomes visible again we recompute
 *            from timestamps and fire immediately if the break is overdue.
 *            Cannot fail, because it runs while the user is looking.
 *
 * Nag scheduling is computed from elapsed time rather than accumulated by a
 * counter, so a check that arrives late (throttled tab, resumed phone) fires
 * exactly the alerts that were due and no duplicates.
 */
(function (global) {
  'use strict';

  var TL = global.T8Timeline;

  var TAG_ONGOING = 't8-ongoing';
  var TAG_NAG = 't8-nag';

  var swRegistration = null;
  var keepAliveEl = null;
  var keepAliveUrl = null;
  var stoppingOnPurpose = false;
  var keepAliveInterrupted = false;

  // Nag bookkeeping for the currently open break/lunch segment.
  // Keyed by the segment's start timestamp so a new break resets it.
  var nagCursor = { since: null, fired: -1 };

  var callbacks = { onResumeRequest: null };

  /* ---------------------------------------------------------------- support */

  function supported() {
    return typeof Notification !== 'undefined';
  }

  function permission() {
    return supported() ? Notification.permission : 'unsupported';
  }

  function granted() {
    return permission() === 'granted';
  }

  /* ------------------------------------------------------- service worker */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    if (location.protocol === 'file:') {
      console.info('Track8: opened from a file:// path, so notifications are limited. Serve over http(s) for the full behaviour.');
      return Promise.resolve(null);
    }

    return navigator.serviceWorker.register('./sw.js')
      .then(function (reg) {
        swRegistration = reg;
        return navigator.serviceWorker.ready;
      })
      .then(function (reg) {
        swRegistration = reg || swRegistration;
        return swRegistration;
      })
      .catch(function (e) {
        console.warn('Track8: service worker registration failed.', e);
        return null;
      });
  }

  /**
   * The service worker relays notification-action taps back to us. If the app
   * was closed it reopens with ?a=resume instead, handled in app.js.
   */
  function listenForServiceWorkerMessages() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data || {};
      if (data.action === 'resume-work' && callbacks.onResumeRequest) {
        callbacks.onResumeRequest();
      }
    });
  }

  /* ------------------------------------------------------------- delivery */

  /**
   * Post a notification, preferring the service worker.
   *
   * `new Notification(...)` throws "Illegal constructor" on Android Chrome, so
   * the service worker path is the only one that works on the target device.
   * The constructor is kept purely as a desktop fallback.
   */
  function show(title, options) {
    if (!granted()) return Promise.resolve(false);

    if (swRegistration && swRegistration.showNotification) {
      return swRegistration.showNotification(title, options)
        .then(function () { return true; })
        .catch(function (e) {
          console.warn('Track8: showNotification failed.', e);
          return false;
        });
    }

    try {
      var n = new Notification(title, options);
      n.onclick = function () {
        global.focus();
        n.close();
      };
      return Promise.resolve(true);
    } catch (e) {
      console.warn('Track8: notification could not be shown on this platform.', e);
      return Promise.resolve(false);
    }
  }

  function clearByTag(tag) {
    if (!swRegistration || !swRegistration.getNotifications) return;
    swRegistration.getNotifications({ tag: tag }).then(function (list) {
      list.forEach(function (n) { n.close(); });
    }).catch(function () { /* nothing actionable */ });
  }

  function requestPermission() {
    if (!supported()) return Promise.resolve('unsupported');
    if (Notification.permission === 'granted') return Promise.resolve('granted');
    if (Notification.permission === 'denied') return Promise.resolve('denied');
    return Notification.requestPermission();
  }

  /* --------------------------------------------------------- keep-alive */

  /**
   * Build a looping, effectively-silent WAV as a blob URL.
   *
   * Android freezes background tabs but exempts pages that are playing media,
   * which is what keeps layer 2's timers running with the screen off. The
   * amplitude is 1/32767 of full scale - inaudible, but real samples, because
   * some engines discard a track that is digitally pure silence.
   */
  function buildSilentTrackUrl() {
    var sampleRate = 8000;
    var seconds = 1;
    var frames = sampleRate * seconds;
    var dataBytes = frames * 2;
    var buffer = new ArrayBuffer(44 + dataBytes);
    var view = new DataView(buffer);

    function writeAscii(offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM header size
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeAscii(36, 'data');
    view.setUint32(40, dataBytes, true);

    for (var f = 0; f < frames; f++) {
      view.setInt16(44 + f * 2, (f % 2 === 0) ? 1 : -1, true);
    }

    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  function startKeepAlive(label) {
    if (!global.T8Store.settings().keepAliveEnabled) return;

    if (!keepAliveEl) {
      keepAliveUrl = buildSilentTrackUrl();
      keepAliveEl = new Audio(keepAliveUrl);
      keepAliveEl.loop = true;
      keepAliveEl.volume = 0.01;
      keepAliveEl.setAttribute('playsinline', '');

      // If this track stops while a break is still open, we did not stop it —
      // the phone did, and layer 2 died with it. We cannot react at the time,
      // because being frozen is the whole point, but we can notice on the way
      // back and stop pretending the background reminder was ever armed.
      //
      // The flag is cleared here rather than in stopKeepAlive because `pause`
      // is delivered asynchronously: resetting it right after calling pause()
      // meant this handler always ran with the flag already false, and every
      // normally-ended break reported itself as killed by the phone.
      keepAliveEl.addEventListener('pause', function () {
        if (stoppingOnPurpose) {
          stoppingOnPurpose = false;
          return;
        }
        keepAliveInterrupted = true;
      });
    }

    keepAliveInterrupted = false;
    stoppingOnPurpose = false;

    var play = keepAliveEl.play();
    if (play && play.catch) {
      play.catch(function (e) {
        // Autoplay policy blocks this unless a gesture started it. Break and
        // lunch are always begun by a tap, so this should not normally fire.
        console.info('Track8: background keep-alive could not start; falling back to catch-up reminders.', e);
      });
    }

    if ('mediaSession' in navigator && global.MediaMetadata) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: label || 'Break running',
          artist: 'Track8 - reminder active',
          album: 'Attendance'
        });
        navigator.mediaSession.setActionHandler('pause', function () {
          if (callbacks.onResumeRequest) callbacks.onResumeRequest();
        });
      } catch (e) { /* metadata is cosmetic */ }
    }
  }

  function stopKeepAlive() {
    if (!keepAliveEl) return;
    // Only arm the flag when a `pause` event is actually coming; pausing an
    // already-paused element fires nothing and would leave it set, swallowing
    // the next real interruption.
    stoppingOnPurpose = !keepAliveEl.paused;
    try {
      keepAliveEl.pause();
      keepAliveEl.currentTime = 0;
    } catch (e) { /* already stopped */ }
    keepAliveInterrupted = false;
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = null; } catch (e) { /* ignore */ }
    }
  }

  /** True when the silent track is actually playing, i.e. layer 2 is live. */
  function keepAliveActive() {
    return !!(keepAliveEl && !keepAliveEl.paused);
  }

  /**
   * True when the phone stopped the keep-alive during a break we never ended.
   * The reminder the user did not get is explained by this being true.
   */
  function keepAliveWasInterrupted() {
    return keepAliveInterrupted;
  }

  /* ------------------------------------------------------------- vibration */

  var BUZZ_PATTERN = [200, 100, 200, 100, 300];

  /**
   * Vibrate directly rather than only asking the notification to do it.
   *
   * The `vibrate` option on a notification is best-effort and frequently
   * ignored: on Android the OS routes an installed web app's notifications
   * through a system notification channel, and the vibration setting on that
   * channel belongs to the user and the OEM, not to us. Plenty of phones
   * default it to off. That is why a reminder can arrive, be visible, make a
   * sound, and still not buzz.
   *
   * navigator.vibrate() is the path we do control. It only works while the
   * page is on screen — Chrome ignores it from a hidden page — so it is not a
   * replacement for the notification's own option, it is a second attempt for
   * the case where the user is actually looking at the app. Both are set.
   *
   * Returns false when nothing could be done, which the settings test reports
   * rather than silently claiming success. iOS has no vibration API at all.
   */
  function buzz(pattern) {
    if (!global.T8Store.settings().vibrate) return false;
    if (typeof navigator.vibrate !== 'function') return false;
    if (document.visibilityState !== 'visible') return false;
    try {
      return navigator.vibrate(pattern || BUZZ_PATTERN) !== false;
    } catch (e) {
      return false;
    }
  }

  function vibrationSupported() {
    return typeof navigator.vibrate === 'function';
  }

  /* -------------------------------------------------------- audible chime */

  function chime() {
    if (document.visibilityState !== 'visible') return; // the OS handles it otherwise
    try {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var now = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.setValueAtTime(880, now + 0.15);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.6);
      setTimeout(function () { ctx.close(); }, 1200);
    } catch (e) { /* audio is a bonus, never a requirement */ }
  }

  /* ------------------------------------------------------ break reminders */

  function config(state) {
    var s = global.T8Store.settings();
    if (state === TL.STATES.LUNCH) {
      return {
        label: 'Lunch',
        icon: '🍱',
        firstMinutes: s.lunchAlertMinutes,
        repeatMinutes: s.lunchRepeatMinutes
      };
    }
    return {
      label: 'Break',
      icon: '☕',
      firstMinutes: s.breakAlertMinutes,
      repeatMinutes: s.breakRepeatMinutes
    };
  }

  /**
   * Body of the pinned notification.
   *
   * States the clock time the user is due back, not just the length of the
   * allowance. The nagging layer needs our timers to still be running, and a
   * phone that has frozen the page will not deliver it — but this notification
   * was posted at the moment the break started, so it survives regardless. If
   * everything else fails, the shade still answers "when should I be back?".
   */
  function ongoingBody(cfg, since) {
    var time = function (ms) {
      return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    return cfg.label + ' started ' + time(since) + ' · back by ' + time(since + cfg.firstMinutes * 60000) +
      '. Tap "End ' + cfg.label.toLowerCase() + '" when you are.';
  }

  /**
   * Pin the ongoing notification for a break that has just started.
   * Silent on purpose: it is a status line, not an alert.
   */
  function onBreakStarted(state, since) {
    var cfg = config(state);
    nagCursor = { since: since, fired: -1 };

    startKeepAlive(cfg.label + ' running');

    return show(cfg.icon + ' On ' + cfg.label.toLowerCase(), {
      body: ongoingBody(cfg, since),
      tag: TAG_ONGOING,
      renotify: false,
      requireInteraction: true,
      silent: true,
      badge: './icons/badge-72.png',
      icon: './icons/icon-192.png',
      data: { kind: 'ongoing', state: state, since: since },
      actions: [{ action: 'resume', title: 'End ' + cfg.label.toLowerCase() }]
    });
  }

  /** Break ended: drop both notifications and release the keep-alive. */
  function onBreakEnded() {
    nagCursor = { since: null, fired: -1 };
    stopKeepAlive();
    clearByTag(TAG_ONGOING);
    clearByTag(TAG_NAG);
  }

  /**
   * Decide how many reminders are due for an open break of `elapsedMs`.
   * Returns -1 before the first is due, then 0, 1, 2 ... for each repeat.
   *
   * Derived from elapsed time rather than incremented per fire, so a phone
   * that was asleep for 40 minutes produces one correct reminder on wake
   * instead of eight queued ones.
   */
  function dueIndex(elapsedMs, cfg) {
    var minutes = elapsedMs / 60000;
    if (minutes < cfg.firstMinutes) return -1;
    var repeat = Math.max(1, cfg.repeatMinutes);
    return Math.floor((minutes - cfg.firstMinutes) / repeat);
  }

  function fireNag(state, elapsedMs, cfg, index) {
    var minutes = Math.floor(elapsedMs / 60000);
    var over = minutes - cfg.firstMinutes;
    var settings = global.T8Store.settings();

    var title = cfg.icon + ' ' + cfg.label + ' running ' + minutes + ' min';
    var body = index === 0
      ? 'You passed your ' + cfg.firstMinutes + ' min ' + cfg.label.toLowerCase() +
        '. Tap "End ' + cfg.label.toLowerCase() + '" to get back on the clock.'
      : over + ' min over your ' + cfg.firstMinutes + ' min limit. Still on ' +
        cfg.label.toLowerCase() + ' - this time is not counting towards your 8 hours.';

    chime();
    buzz();

    return show(title, {
      body: body,
      tag: TAG_NAG,
      renotify: true,
      requireInteraction: true,
      vibrate: settings.vibrate ? BUZZ_PATTERN : undefined,
      badge: './icons/badge-72.png',
      icon: './icons/icon-192.png',
      data: { kind: 'nag', state: state, elapsedMs: elapsedMs },
      actions: [{ action: 'resume', title: 'End ' + cfg.label.toLowerCase() }]
    });
  }

  /**
   * Evaluate the open break and fire whatever is due.
   *
   * Safe to call at any frequency: once a second while visible, once on wake,
   * or not at all for an hour. `summary` comes from T8Timeline.summarize, so
   * elapsed time is always measured, never counted.
   */
  function check(summary) {
    if (!summary || (summary.state !== TL.STATES.BREAK && summary.state !== TL.STATES.LUNCH)) {
      if (nagCursor.since !== null) onBreakEnded();
      return null;
    }

    var cfg = config(summary.state);

    // A break restored from storage after a reload has no cursor yet. Adopt it
    // without replaying reminders the user already saw before the reload.
    if (nagCursor.since !== summary.openSince) {
      nagCursor = { since: summary.openSince, fired: -1 };
      startKeepAlive(cfg.label + ' running');
    }

    var index = dueIndex(summary.openMs, cfg);
    if (index > nagCursor.fired) {
      nagCursor.fired = index;
      fireNag(summary.state, summary.openMs, cfg, index);
      return { fired: true, index: index, minutes: Math.floor(summary.openMs / 60000) };
    }

    return { fired: false, index: index, minutes: Math.floor(summary.openMs / 60000) };
  }

  function init(options) {
    callbacks.onResumeRequest = (options && options.onResumeRequest) || null;
    listenForServiceWorkerMessages();
    return registerServiceWorker();
  }

  global.T8Notify = {
    init: init,
    supported: supported,
    permission: permission,
    granted: granted,
    requestPermission: requestPermission,
    show: show,
    buzz: buzz,
    vibrationSupported: vibrationSupported,
    check: check,
    onBreakStarted: onBreakStarted,
    onBreakEnded: onBreakEnded,
    startKeepAlive: startKeepAlive,
    stopKeepAlive: stopKeepAlive,
    keepAliveActive: keepAliveActive,
    keepAliveWasInterrupted: keepAliveWasInterrupted,
    dueIndex: dueIndex,
    hasServiceWorker: function () { return !!swRegistration; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
