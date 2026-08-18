/**
 * Track8 - Timeline
 *
 * The core of the app. A day is stored as an ordered list of events, not as
 * accumulated counters. Each event records the exact moment a state began:
 *
 *   [{ t: 1755054000000, s: 'WORKING' },
 *    { t: 1755065400000, s: 'BREAK'   },
 *    { t: 1755066720000, s: 'WORKING' }]
 *
 * Durations are derived by subtracting timestamps, never by counting ticks.
 * That makes every total correct even if the tab was closed, the phone slept,
 * the browser throttled our timers, or the machine was suspended for a week.
 *
 * This module is pure: no DOM, no storage, no clock reads except the `now`
 * argument callers pass in. That keeps it trivially testable.
 */
(function (global) {
  'use strict';

  var STATES = {
    WORKING: 'WORKING',
    MEETING: 'MEETING',
    BREAK: 'BREAK',
    LUNCH: 'LUNCH',
    PAUSED: 'PAUSED',
    ENDED: 'ENDED'
  };

  // States whose elapsed time is accumulated into a named bucket. ENDED is
  // absent on purpose: it is off-the-clock time and accrues nothing.
  var BUCKET_OF = {
    WORKING: 'workMs',
    MEETING: 'meetingMs',
    BREAK: 'breakMs',
    LUNCH: 'lunchMs',
    PAUSED: 'pausedMs'
  };

  // Buckets that count towards the daily target. Meetings are work.
  var CREDITED = ['workMs', 'meetingMs'];

  var DAY_MS = 24 * 60 * 60 * 1000;

  // The hour a day stops accruing on its own. A shift still open at 10 pm was
  // almost certainly forgotten, and a forgotten shift left alone reports every
  // hour since - 30h, 42h - into the week bars, the calendar and the export.
  var AUTO_END_HOUR = 22;

  /** Local-calendar date key (YYYY-MM-DD) for a Date or epoch ms. */
  function dateKeyOf(when) {
    var d = (when instanceof Date) ? when : new Date(when);
    return d.getFullYear() +
      '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  /**
   * Parse a YYYY-MM-DD key into a local-midnight Date.
   * `new Date('2026-08-13')` parses as UTC and silently shifts the day for
   * anyone west of Greenwich, so we never use it.
   */
  function dateFromKey(dateKey) {
    var parts = String(dateKey).split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  /**
   * The instant a date key's day ends, i.e. the next local midnight.
   *
   * Deliberately NOT `dateFromKey(key) + DAY_MS`. On a daylight-saving day the
   * local day is 23 or 25 hours long, so adding a fixed 24h lands an hour off:
   * on a fall-back day it resolves to 23:00 of the SAME date, which made the
   * midnight split hand back a "next" day identical to the one it just closed.
   * Calendar arithmetic asks the runtime for the real next midnight instead.
   */
  function nextMidnightOf(dateKey) {
    var d = dateFromKey(dateKey);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }

  /**
   * The instant a day stops accruing: 10 pm local.
   *
   * A day whose own last event is at or after the cutoff keeps its midnight
   * instead. Someone genuinely still transitioning at 10 pm is working late,
   * not forgetting - and closing a day before its last event is not a
   * correction anyway, since pushEvent would only bump the ENDED marker back
   * past it and collapse that stretch into a second.
   */
  function autoEndOf(dateKey, day) {
    var d = dateFromKey(dateKey);
    var cutoff = new Date(d.getFullYear(), d.getMonth(), d.getDate(), AUTO_END_HOUR).getTime();
    var last = lastEvent(day);
    if (last && last.t >= cutoff) return nextMidnightOf(dateKey);
    return cutoff;
  }

  /**
   * The instant to measure a day up to: now, but never past the point it stops
   * accruing. Every screen, the correction form and the export must agree on
   * this, or a forgotten shift shows a different number in each of them.
   */
  function measuredAt(day, now) {
    var end = (now == null) ? Date.now() : now;
    if (!day || !day.dateKey) return end;
    return Math.min(end, autoEndOf(day.dateKey, day));
  }

  /**
   * Close a day that is still running past its cutoff. Returns true when the
   * day changed, so the caller knows to stamp and persist it.
   *
   * The ENDED event is stamped at the cutoff, not at `now`: the total then
   * reads as it would have had the user tapped End day at 10 pm, whether the
   * app finds out a minute later or a week later. Nothing is lost either way -
   * Reopen puts the day back, and the correction form can still set the real
   * hours.
   */
  function autoClose(day, now) {
    if (!isRunning(day)) return false;

    var cutoff = autoEndOf(day.dateKey, day);
    // A late shift's cutoff is its own midnight, and midnight belongs to
    // splitAtMidnight - it carries the running state into the new day rather
    // than ending it.
    if (cutoff >= nextMidnightOf(day.dateKey)) return false;
    if (((now == null) ? Date.now() : now) < cutoff) return false;
    if (!pushEvent(day, STATES.ENDED, cutoff)) return false;

    day.autoEnded = true;
    return true;
  }

  function createDay(dateKey) {
    return { dateKey: dateKey, events: [], note: '' };
  }

  function lastEvent(day) {
    if (!day || !day.events || !day.events.length) return null;
    return day.events[day.events.length - 1];
  }

  /** Current state of a day: whatever its last event says, IDLE if empty. */
  function currentState(day) {
    var last = lastEvent(day);
    return last ? last.s : 'IDLE';
  }

  /**
   * The state immediately before the current one, or IDLE if there is none.
   *
   * Used to decide where finishing a meeting returns to: back to work if the
   * meeting interrupted a shift, back to off-the-clock if it was logged after
   * the day had already been ended.
   */
  function previousState(day) {
    if (!day || !day.events || day.events.length < 2) return 'IDLE';
    return day.events[day.events.length - 2].s;
  }

  function isEnded(day) {
    return currentState(day) === STATES.ENDED;
  }

  function isRunning(day) {
    var s = currentState(day);
    return s !== 'IDLE' && s !== STATES.ENDED;
  }

  /**
   * Append a state transition. Returns true if it was recorded.
   *
   * Rejects no-op transitions (same state twice) and any event at or before
   * the previous one, which would make durations negative. Clock drift, manual
   * system-time changes and NTP corrections all produce backwards timestamps,
   * so this guard is load-bearing rather than defensive noise.
   */
  function pushEvent(day, state, when) {
    var t = (when == null) ? Date.now() : when;
    var last = lastEvent(day);

    if (last) {
      if (last.s === state) return false;
      if (t <= last.t) t = last.t + 1000; // keep the timeline monotonic
    }

    day.events.push({ t: t, s: state });
    return true;
  }

  /**
   * Expand a day's events into closed segments.
   *
   * The final segment of a still-running day is closed at `now`, which is what
   * makes a locked phone irrelevant: we are measuring an interval, not counting
   * seconds as they pass.
   *
   * ENDED spans are skipped rather than ending the walk. A day can be ended and
   * then reopened by a late meeting, and the meeting after it must still be
   * measured - but the off-the-clock gap in between is not something anyone
   * wants to see listed.
   */
  function segmentsOf(day, now) {
    var out = [];
    if (!day || !day.events || !day.events.length) return out;

    var events = day.events;
    var end = (now == null) ? Date.now() : now;

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.s === STATES.ENDED) continue;

      var next = events[i + 1];
      var stop = next ? next.t : end;
      if (stop < ev.t) stop = ev.t;

      out.push({ state: ev.s, from: ev.t, to: stop, ms: stop - ev.t });
    }

    return out;
  }

  /**
   * Totals for a day, in milliseconds, plus the live segment if one is open.
   *
   * `creditedMs` is what counts against the daily target: worked time plus
   * meetings. `openMs` is how long the *current* state has been running, which
   * is what the break reminder is driven off - a break that began before the
   * phone slept still reports its true age on wake.
   */
  function summarize(day, now) {
    var end = (now == null) ? Date.now() : now;

    var totals = {
      workMs: 0,
      meetingMs: 0,
      breakMs: 0,
      lunchMs: 0,
      pausedMs: 0,
      creditedMs: 0,
      state: currentState(day),
      openMs: 0,
      openSince: null,
      firstIn: null,
      lastOut: null,
      ended: isEnded(day)
    };

    if (!day || !day.events || !day.events.length) return totals;

    var segments = segmentsOf(day, end);
    for (var i = 0; i < segments.length; i++) {
      var bucket = BUCKET_OF[segments[i].state];
      if (bucket) totals[bucket] += segments[i].ms;
    }

    for (var c = 0; c < CREDITED.length; c++) totals.creditedMs += totals[CREDITED[c]];

    totals.firstIn = day.events[0].t;

    // The last time the user clocked off, wherever that sits in the log. A day
    // ended at 18:00 and reopened for a 20:00 meeting has two ENDED events.
    for (var j = day.events.length - 1; j >= 0; j--) {
      if (day.events[j].s === STATES.ENDED) {
        totals.lastOut = day.events[j].t;
        break;
      }
    }

    var last = lastEvent(day);
    if (last.s !== STATES.ENDED) {
      totals.openSince = last.t;
      totals.openMs = Math.max(0, end - last.t);
    }

    return totals;
  }

  /** Convenience: credited milliseconds (work + meetings) for a day. */
  function creditedMsOf(day, now) {
    return summarize(day, now).creditedMs;
  }

  /**
   * Split a day whose timeline ran past midnight.
   *
   * Returns { closed, carried } where `closed` is the original day truncated at
   * local midnight and `carried` is a fresh day record for the following date
   * that resumes in the same state. Returns null when no split is needed.
   *
   * Without this, a shift left running overnight would write today's entire
   * total into tomorrow's record as well, inventing hours that were never
   * worked.
   */
  function splitAtMidnight(day, now) {
    if (!isRunning(day)) return null;

    var end = (now == null) ? Date.now() : now;
    var boundary = nextMidnightOf(day.dateKey);
    if (end < boundary) return null;

    var carriedKey = dateKeyOf(boundary);
    // Belt and braces: a carried key equal to the original would make the
    // caller overwrite the day it just closed, and never terminate its loop.
    if (carriedKey === day.dateKey) return null;

    var state = currentState(day);
    var afterHours = previousState(day) === STATES.ENDED;

    var closed = {
      dateKey: day.dateKey,
      note: day.note,
      events: day.events.filter(function (ev) { return ev.t < boundary; })
    };

    // The closing sentinel must sit after every event it retains. Tapping
    // Break at 23:59:59.4 would otherwise place ENDED before it, and the
    // store's load-time sort would then leave the day open forever.
    var kept = closed.events[closed.events.length - 1];
    var closeAt = kept ? Math.max(boundary - 1000, kept.t + 1) : boundary - 1000;
    closed.events.push({ t: Math.min(closeAt, boundary - 1), s: STATES.ENDED });

    var carried = createDay(carriedKey);

    // A meeting logged after the day was already ended keeps that context
    // across the boundary: without this leading sentinel the carried day looks
    // like a shift that began with a meeting, and finishing it would clock the
    // user in for the rest of the night. The marker sits 1ms before midnight so
    // the meeting itself still starts exactly at 00:00 and loses no time.
    if (afterHours) carried.events.push({ t: boundary - 1, s: STATES.ENDED });
    carried.events.push({ t: boundary, s: state });

    // Anything the user logged after midnight belongs to the new day.
    day.events.forEach(function (ev) {
      if (ev.t >= boundary) carried.events.push({ t: ev.t, s: ev.s });
    });

    return { closed: closed, carried: carried };
  }

  /**
   * Rebuild a day's events from edited totals, preserving clock-in time.
   * Used by the manual-correction editor: the user thinks in "6h 30m worked",
   * not in transition timestamps.
   *
   * The synthesised order - work, meeting, break, lunch, paused - is not what
   * anybody's day looked like, and it does not have to be: every total in the
   * app is a sum over segments, so only the durations and the clock-in are
   * load-bearing. What matters is that the log stays monotonic and readable.
   *
   * `opts.leaveOpen` corrects a day that has not finished yet - today, usually.
   * It ends the log with an open WORKING event instead of an ENDED one, so the
   * timer picks the day straight back up. Without it, correcting today would
   * clock the user out as the price of fixing a stray Pause.
   */
  function rebuildFromTotals(dateKey, opts) {
    var day = createDay(dateKey);
    var base = dateFromKey(dateKey).getTime();

    var startMs = (opts.startMs == null) ? base + 9 * 3600000 : opts.startMs;
    var blocks = [
      [STATES.WORKING, Math.max(0, opts.workMs || 0)],
      [STATES.MEETING, Math.max(0, opts.meetingMs || 0)],
      [STATES.BREAK, Math.max(0, opts.breakMs || 0)],
      [STATES.LUNCH, Math.max(0, opts.lunchMs || 0)],
      [STATES.PAUSED, Math.max(0, opts.pausedMs || 0)]
    ];

    var cursor = startMs;
    for (var i = 0; i < blocks.length; i++) {
      // A zero-length block would collapse into the next one and lose its
      // identity, so only real durations become events.
      if (blocks[i][1] <= 0) continue;
      day.events.push({ t: cursor, s: blocks[i][0] });
      cursor += blocks[i][1];
    }

    if (!day.events.length) day.events.push({ t: startMs, s: STATES.WORKING });

    if (opts.leaveOpen) {
      // A second WORKING event would be a same-state repeat, and pushEvent
      // rejects those for a reason: it would read as a transition that never
      // happened and split one stretch of desk work into two.
      if (lastEvent(day).s !== STATES.WORKING) day.events.push({ t: cursor, s: STATES.WORKING });
    } else {
      day.events.push({ t: cursor, s: STATES.ENDED });
    }

    day.note = opts.note || '';
    return day;
  }

  global.T8Timeline = {
    STATES: STATES,
    BUCKET_OF: BUCKET_OF,
    DAY_MS: DAY_MS,
    AUTO_END_HOUR: AUTO_END_HOUR,
    dateKeyOf: dateKeyOf,
    dateFromKey: dateFromKey,
    nextMidnightOf: nextMidnightOf,
    autoEndOf: autoEndOf,
    measuredAt: measuredAt,
    autoClose: autoClose,
    createDay: createDay,
    lastEvent: lastEvent,
    currentState: currentState,
    previousState: previousState,
    isEnded: isEnded,
    isRunning: isRunning,
    pushEvent: pushEvent,
    segmentsOf: segmentsOf,
    summarize: summarize,
    creditedMsOf: creditedMsOf,
    splitAtMidnight: splitAtMidnight,
    rebuildFromTotals: rebuildFromTotals
  };
})(typeof window !== 'undefined' ? window : globalThis);
