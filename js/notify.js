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
  var Shift = global.T8Shift;
  var Handoff = global.T8Handoff;

  var TAG_ONGOING = Shift.TAG;
  var TAG_NAG = 't8-nag';

  // Borrowed from the shared card so the page and the worker format a time and a
  // duration identically. A notification the worker redraws must not suddenly
  // change how it writes 14:35.
  var clock = Shift.clock;
  var shortMs = Shift.shortMs;

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
   *
   * `drain` is the other direction of the same conversation: the worker has just
   * settled a break on its own and is telling a page that happens to be alive to
   * write it into the log now rather than on the next launch.
   */
  /* `lunch`, `pause` and `end` are no longer on any card this version draws.
     They stay because a phone can still be holding a notification posted by an
     older service worker - the card outlives the code that made it - and a tap
     on one of those buttons has to land somewhere rather than be dropped in
     silence. Delete them only once no such worker can plausibly be installed. */
  var SW_ACTIONS = {
    'resume-work': 'onResumeRequest',
    'break': 'onBreakRequest',
    lunch: 'onLunchRequest',
    pause: 'onPauseRequest',
    end: 'onEndDayRequest',
    drain: 'onDrainRequest'
  };

  function listenForServiceWorkerMessages() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data || {};
      var fn = callbacks[SW_ACTIONS[data.action]];
      if (!fn) return;

      // Answer first, act second. Android goes on listing a window whose page it
      // has already discarded, and a message posted into that ghost is dropped
      // in silence - so the worker reads "no answer" as "no page" and reloads
      // the window with the action in the URL instead. The reply therefore has
      // to go out before the action runs, or a slow save would be mistaken for
      // a dead page and cost the user a reload.
      if (event.ports && event.ports[0]) {
        try { event.ports[0].postMessage({ ok: true }); } catch (e) { /* older worker, no port */ }
      }

      fn();
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
   * amplitude is a hair off silence - inaudible, but real samples, because some
   * engines discard a track that is digitally pure silence.
   *
   * Ten seconds, not one. Chrome treats anything under about five seconds as a
   * UI sound effect and gives it no audio focus, and audio focus is what buys
   * the background exemption in the first place.
   */
  function buildSilentTrackUrl() {
    var sampleRate = 8000;
    var seconds = 10;
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

    // A 40Hz sine rather than an alternating ±1, which was a full-scale-Nyquist
    // tone kept inaudible only by being one bit tall. Browsers decide whether a
    // page is "making a sound" by measuring signal power, and a one-bit signal
    // can read as silence - which loses the background exemption the whole
    // keep-alive exists for. 40Hz at
    // this level is below what a phone speaker can reproduce and far below
    // hearing on headphones, but it is unambiguously a signal. A whole number
    // of cycles per loop, so the seam does not click.
    var cycles = Math.round(40 * seconds);
    var peak = 0.05 * 32767;
    for (var f = 0; f < frames; f++) {
      view.setInt16(44 + f * 2, Math.round(peak * Math.sin(2 * Math.PI * cycles * f / frames)), true);
    }

    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  function startKeepAlive() {
    if (!global.T8Store.settings().keepAliveEnabled) return;

    if (!keepAliveEl) {
      keepAliveUrl = buildSilentTrackUrl();
      keepAliveEl = new Audio(keepAliveUrl);
      keepAliveEl.loop = true;
      // Not 0, and not near enough to 0 to be mistaken for it: a muted or
      // effectively-silent element is denied audio focus, and without audio
      // focus Android stops treating the page as one that may keep running.
      // 0.05 of a 40Hz tone is still nothing any phone speaker can reproduce.
      keepAliveEl.volume = 0.05;
      keepAliveEl.setAttribute('playsinline', '');
      keepAliveEl.setAttribute('aria-hidden', 'true');
      // In the document, not floating detached. An audio element with no
      // `controls` renders nothing, so this costs no layout - but a player the
      // browser can see in the page is the case every implementation is written
      // for, and a detached one is not worth betting the reminder on.
      document.body.appendChild(keepAliveEl);

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

    // play() on an already-playing element resolves without doing anything, so
    // this is safe to call every tick.
    if (keepAliveEl.paused) {
      var play = keepAliveEl.play();
      if (play && play.catch) {
        play.catch(function (e) {
          // Autoplay policy blocks this unless a gesture started it. Break and
          // lunch are always begun by a tap, so this should not normally fire.
          console.info('Track8: background keep-alive could not start; falling back to catch-up reminders.', e);
        });
      }
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
  }

  /** True when the silent track is actually playing, i.e. layer 2 is live. */
  function keepAliveActive() {
    return !!(keepAliveEl && !keepAliveEl.paused);
  }

  /**
   * Two different lifetimes, deliberately.
   *
   * The silent track is held only through a resting segment, because that is
   * the only stretch layer 2 has to nag through - work and meeting time is
   * credited whether the page lives or not, so holding audio focus across a
   * whole shift is battery spent for nothing.
   *
   * The pinned notification runs for the whole open day, because its buttons
   * are how a break is STARTED without unlocking the phone. Tying it to the
   * track instead left the shade empty all morning and the card appearing only
   * once a break was already running, which is the half of the feature nobody
   * needs. A notification costs nothing to keep posted.
   */
  function syncBackground(summary, cfg) {
    if (!(cfg && cfg.resting)) stopKeepAlive();

    var open = summary.state !== TL.STATES.ENDED && summary.state !== 'IDLE';
    if (open) {
      postShiftNotification(summary.state, summary.openSince, creditedBefore(summary));
    } else {
      clearShiftNotification();
    }
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

  /**
   * What each naggable state is called, when it starts nagging, and whether it
   * is worth keeping the page alive for.
   *
   * `kind` is the key into the quip packs. `resting` means the time is not
   * being credited, which is what earns an "End ..." action button and the
   * silent keep-alive track; a meeting and a long stretch at the desk are both
   * credited, so they get a nudge and nothing else - keeping a phone awake for
   * time that is already counting would be a battery cost with no payoff.
   *
   * WORKING is in here as the "you have not moved in two hours" reminder: it is
   * the same shape as every other one, an open segment that has run too long.
   */
  function config(state) {
    var s = global.T8Store.settings();

    if (state === TL.STATES.LUNCH) {
      return {
        kind: 'LUNCH', label: 'Lunch', icon: '🍱', resting: true,
        firstMinutes: s.lunchAlertMinutes, repeatMinutes: s.lunchRepeatMinutes
      };
    }
    if (state === TL.STATES.BREAK) {
      return {
        kind: 'BREAK', label: 'Break', icon: '☕', resting: true,
        firstMinutes: s.breakAlertMinutes, repeatMinutes: s.breakRepeatMinutes
      };
    }
    // Zero is how the settings screen says "never nag me about this one". It
    // has to be checked here rather than left to dueIndex, which would read a
    // zero-minute allowance as "already over" and fire on the first tick.
    if (state === TL.STATES.PAUSED && s.pauseAlertMinutes > 0) {
      return {
        kind: 'PAUSE', label: 'Pause', icon: '⏸️', resting: true,
        firstMinutes: s.pauseAlertMinutes, repeatMinutes: s.pauseRepeatMinutes
      };
    }
    if (state === TL.STATES.MEETING && s.meetingAlertMinutes > 0) {
      return {
        kind: 'MEETING', label: 'Meeting', icon: '👥', resting: false,
        firstMinutes: s.meetingAlertMinutes, repeatMinutes: s.meetingRepeatMinutes
      };
    }
    if (state === TL.STATES.WORKING && s.stretchAlertMinutes > 0) {
      return {
        kind: 'STRETCH', label: 'At the desk', icon: '🧘', resting: false,
        firstMinutes: s.stretchAlertMinutes, repeatMinutes: s.stretchRepeatMinutes
      };
    }
    return null;
  }

  var OVERTIME = { kind: 'OVERTIME', label: 'Day complete', icon: '🎯' };

  /**
   * The pinned entry that follows a break or a lunch.
   *
   * A notification is the one surface where a button can say what it does, and
   * it shows on the lock screen too, so this is how a break is ended without
   * unlocking the phone.
   *
   * What it says and which buttons it carries live in js/shift-card.js, because
   * the service worker redraws this same notification when a break is ended from
   * the shade with the app closed. One description, two writers.
   *
   * The snapshot doubles as what the worker reads to know a break is running at
   * all, which is why it names the allowances rather than the alert config: the
   * worker has no access to settings.
   */
  function snapshotOf(state, since, creditedBeforeMs) {
    var s = global.T8Store.settings();
    return {
      state: state,
      openSince: since,
      creditedBeforeMs: creditedBeforeMs,
      breakAlertMinutes: s.breakAlertMinutes,
      breakRepeatMinutes: s.breakRepeatMinutes,
      lunchAlertMinutes: s.lunchAlertMinutes,
      lunchRepeatMinutes: s.lunchRepeatMinutes
    };
  }

  /**
   * Credited time banked before the open segment began.
   *
   * `summary.creditedMs` counts the open segment up to now, which is right for
   * the screen and wrong for anything stored: see the note in js/shift-card.js
   * about the same stretch being counted twice.
   */
  function creditedBefore(summary) {
    var open = Shift.counting(summary.state) ? summary.openMs : 0;
    return Math.max(0, summary.creditedMs - open);
  }

  /**
   * Leave the worker enough of the day to redraw the notification and to settle
   * a break on its own.
   *
   * Called on transitions, never per tick - an IndexedDB write a second is a
   * battery bug on a phone in a pocket. Transition-time is enough because the
   * only numbers in it that move are credited time, and credited time is frozen
   * for the whole of a break, which is exactly when the worker needs to read it.
   *
   * A day that is idle or ended has its snapshot removed instead, or the worker
   * would go on offering to end a break that finished yesterday.
   */
  function publishSnapshot(summary) {
    if (!Handoff) return Promise.resolve(false);
    if (!summary || summary.state === 'IDLE' || summary.state === TL.STATES.ENDED) {
      return Handoff.clearSnapshot();
    }
    return Handoff.putSnapshot(snapshotOf(summary.state, summary.openSince, creditedBefore(summary)));
  }

  // What was last posted, so a notification that has not changed is not
  // re-posted every second - which on Android is a visible flicker in the shade.
  var lastShiftKey = '';

  function postShiftNotification(state, since, creditedBeforeMs) {
    var snap = snapshotOf(state, since, creditedBeforeMs);
    if (!Shift.actions(snap)) { clearShiftNotification(); return; }

    // Re-post on the state changing or the minute turning, and not otherwise.
    // Keyed on the minute the card will show rather than on banked time, which
    // does not move while the clock runs and would freeze the shade at whatever
    // it said when the shift started.
    var now = Date.now();
    var key = state + '|' + Math.floor(Shift.creditedAt(snap, now) / 60000);
    if (key === lastShiftKey) return;
    lastShiftKey = key;

    show(Shift.title(snap), Shift.options(snap, now));
  }

  function clearShiftNotification() {
    lastShiftKey = '';
    clearByTag(TAG_ONGOING);
  }

  /**
   * A break has just begun. Pins its entry immediately rather than waiting for
   * the next tick, because the gap would be visible on the phone in the hand
   * that just tapped the button.
   *
   * `creditedBeforeMs` is the day's banked total, which for a resting state is
   * simply its credited time - nothing is accruing. It does not reach the body of
   * a break's notification, but it does decide when the entry is next re-posted.
   */
  function onBreakStarted(state, since, creditedBeforeMs) {
    nagCursor = { since: since, fired: -1 };
    startKeepAlive();
    postShiftNotification(state, since, creditedBeforeMs || 0);
  }

  /** Break ended: drop the nag and let the shift entry catch up on the tick. */
  function onBreakEnded() {
    nagCursor = { since: null, fired: -1 };
    stopKeepAlive();
    clearShiftNotification();
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

  /**
   * The facts half, one short sentence per kind.
   *
   * Short on purpose: the quip is already a line, the title carries the minutes,
   * and Android truncates a notification body at about two lines on a lock
   * screen. Everything worth acting on has to survive that cut.
   */
  function nagFacts(cfg, minutes, over) {
    if (cfg.resting) return over + ' min over your ' + cfg.firstMinutes + ' min ' + cfg.label.toLowerCase() + '. Not counting.';
    if (cfg.kind === 'MEETING') return minutes + ' min in. Still counting towards your day.';
    if (cfg.kind === 'STRETCH') return minutes + ' min at the desk without a break.';
    return minutes + ' min.';
  }

  function fireNag(state, elapsedMs, cfg, index) {
    var minutes = Math.floor(elapsedMs / 60000);
    var over = minutes - cfg.firstMinutes;
    var settings = global.T8Store.settings();

    // The quip leads, the facts follow. Guarded because a rolling deploy can
    // serve an index.html that predates js/quips.js, and this is the one path
    // that must never throw.
    var quip = global.T8Quips ? global.T8Quips.forKind(cfg.kind, Math.max(0, over)) : '';
    var facts = nagFacts(cfg, minutes, over);

    chime();
    buzz();

    var options = {
      body: quip ? quip + ' ' + facts : facts,
      tag: TAG_NAG,
      renotify: true,
      requireInteraction: cfg.resting,
      vibrate: settings.vibrate ? BUZZ_PATTERN : undefined,
      badge: './icons/badge-72.png',
      icon: './icons/icon-192.png',
      data: { kind: 'nag', state: state, elapsedMs: elapsedMs }
    };

    // Only resting time has a one-tap fix from the shade. "End meeting" would
    // be a lie - the meeting is not the app's to end - and there is no action
    // that shortens a long stretch at the desk except standing up.
    if (cfg.resting) {
      options.actions = [{ action: 'resume', title: 'End ' + cfg.label.toLowerCase() }];
    }

    // Elapsed time lives in the title, which is the only part of a notification
    // the OS renders bold - and it is formatted rather than left in raw
    // minutes, because "1h 22m" reads at a glance and "82 min" does not.
    return show(cfg.icon + ' ' + cfg.label + ' · ' + shortMs(elapsedMs), options);
  }

  /**
   * The day is done: credited time has reached the target.
   *
   * Fired once when the goal is crossed and then every `overtimeRepeatMinutes`
   * while the clock is still running, so a day nobody ended keeps asking. Like
   * every other reminder it is derived from measured time, not counted, so a
   * phone that was asleep through the crossing fires one on wake rather than a
   * queue of them.
   */
  function fireOvertime(overtimeMs, index) {
    var minutes = Math.floor(overtimeMs / 60000);
    var settings = global.T8Store.settings();
    var quip = global.T8Quips ? global.T8Quips.forKind(OVERTIME.kind, minutes) : '';
    var facts = index === 0
      ? 'You have hit your daily target.'
      : minutes + ' min past your target, still on the clock.';

    chime();
    buzz();

    return show(OVERTIME.icon + ' ' + OVERTIME.label +
      (minutes > 0 ? ' · ' + shortMs(overtimeMs) + ' over' : ''), {
      body: quip ? quip + ' ' + facts : facts,
      tag: TAG_NAG,
      renotify: true,
      requireInteraction: false,
      vibrate: settings.vibrate ? BUZZ_PATTERN : undefined,
      badge: './icons/badge-72.png',
      icon: './icons/icon-192.png',
      data: { kind: 'overtime', overtimeMs: overtimeMs }
    });
  }

  // Which day the overtime reminder has already fired for, and how many times.
  // Keyed by date so a new day starts silent, and so a phone left open
  // overnight does not think yesterday's target is still news.
  var overtimeCursor = { key: null, fired: -1 };

  function checkOvertime(summary) {
    var key = TL.dateKeyOf(Date.now());
    if (overtimeCursor.key !== key) overtimeCursor = { key: key, fired: -1 };

    var settings = global.T8Store.settings();
    if (!settings.overtimeReminder) return;

    // Only while the clock is actually running. A day that has been ended has
    // already answered the question this reminder asks.
    var running = summary.state === TL.STATES.WORKING || summary.state === TL.STATES.MEETING;
    if (!running) return;

    var target = settings.dailyTargetMinutes * 60000;
    if (target <= 0 || summary.creditedMs < target) return;

    var overtimeMs = summary.creditedMs - target;
    var repeat = Math.max(1, settings.overtimeRepeatMinutes) * 60000;
    var index = Math.floor(overtimeMs / repeat);

    if (index > overtimeCursor.fired) {
      overtimeCursor.fired = index;
      fireOvertime(overtimeMs, index);
    }
  }

  /**
   * Evaluate the open break and fire whatever is due.
   *
   * Safe to call at any frequency: once a second while visible, once on wake,
   * or not at all for an hour. `summary` comes from T8Timeline.summarize, so
   * elapsed time is always measured, never counted.
   */
  function check(summary) {
    if (!summary) return null;

    checkOvertime(summary);

    var cfg = config(summary.state);

    if (!cfg) {
      if (nagCursor.since !== null) onBreakEnded();
      // Still runs, to put away anything a previous state left standing.
      syncBackground(summary, null);
      return null;
    }

    // A break restored from storage after a reload has no cursor yet. Adopt it
    // without replaying reminders the user already saw before the reload.
    if (nagCursor.since !== summary.openSince) {
      nagCursor = { since: summary.openSince, fired: -1 };
      // Only resting time is worth holding the page awake for: working and
      // meeting time is credited whether the page lives or not.
      if (cfg.resting) startKeepAlive();
    }

    syncBackground(summary, cfg);

    var index = dueIndex(summary.openMs, cfg);
    if (index > nagCursor.fired) {
      nagCursor.fired = index;
      fireNag(summary.state, summary.openMs, cfg, index);
      return { fired: true, index: index, minutes: Math.floor(summary.openMs / 60000) };
    }

    return { fired: false, index: index, minutes: Math.floor(summary.openMs / 60000) };
  }

  function init(options) {
    var opts = options || {};
    // Every one of these is a button on the pinned notification, or the
    // worker telling a live page to file a tap it took on its own.
    ['onResumeRequest', 'onBreakRequest', 'onLunchRequest', 'onPauseRequest',
      'onEndDayRequest', 'onDrainRequest'].forEach(function (name) {
      callbacks[name] = opts[name] || null;
    });
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
    publishSnapshot: publishSnapshot,
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
