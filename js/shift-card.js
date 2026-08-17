/**
 * Track8 - the pinned shift notification, shaped in one place
 *
 * Loaded by the page and, through importScripts, by the service worker, because
 * both of them now draw this notification: the page redraws it as the minutes
 * turn, and the worker redraws it when a break is started or ended from the
 * shade with the app closed. Two copies of these strings would drift, and the
 * first symptom of the drift would be a notification insisting the user is on a
 * break they have just ended.
 *
 * Everything here comes from a snapshot - state, when it began, the credited time
 * banked before it began, and the two allowances - because that is the most the
 * worker can know. It cannot read localStorage, so it cannot ask T8Store
 * anything.
 *
 * `creditedBeforeMs` is banked time only, deliberately: it excludes the segment
 * that is still open. A snapshot holding credited-time-as-of-now goes stale the
 * moment it is written, and adding the open stretch to it again at draw time
 * counts that stretch twice - which read as eighteen minutes of work appearing
 * out of nowhere the first time this was built. Banked time never moves, so the
 * arithmetic is done once, here, against a `now` the caller supplies.
 *
 * A notification body has no markup of any kind. The title is the only line the
 * OS renders in bold, which is why the time the user is due back lives up there
 * rather than in the body.
 */
(function (global) {
  'use strict';

  var TAG = 't8-ongoing';

  /* One button or two, never three, and never a destructive one beside a routine
     one.

     Android lays these out as a single row of text buttons splitting the width
     between them, so the count decides the size of the target. Three buttons on
     a phone leaves each about a thumb's width and they are mis-hit: a tap meant
     for Break landed on Lunch. Two buttons take half the row each, which is the
     one shape that reads unambiguously - Break on the left, Lunch on the right.

     Pause is not here for that reason. It is the least urgent thing this card
     could offer and it was costing the two that matter their room; it is a tap
     away in the app.

     End day is not here either, and that one was doing real damage. It sat next
     to "Back on the clock", so a miss ended the whole day instead of resuming it.
     The lock screen still reaches it without unlocking, through the media card's
     stop button, where nothing benign is adjacent to it.

     A break and a lunch carry one button, full width. Offering "lunch instead"
     mid-break was a second way to be wrong about which one you are on, and the
     only reason anyone opens that notification is to end the thing running. */
  var ACTIONS = {
    WORKING: [
      { action: 'break', title: '☕ Break' },
      { action: 'lunch', title: '🍱 Lunch' }
    ],
    MEETING: [
      { action: 'break', title: '☕ Break' },
      { action: 'lunch', title: '🍱 Lunch' }
    ],
    BREAK: [
      { action: 'resume', title: 'End break' }
    ],
    LUNCH: [
      { action: 'resume', title: 'End lunch' }
    ],
    PAUSED: [
      { action: 'resume', title: '▶ Back on the clock' }
    ]
  };

  var TITLES = {
    WORKING: '⏱️ On the clock',
    MEETING: '👥 In a meeting',
    PAUSED: '⏸️ Paused'
  };

  /* The two states that quote a time to be back by. A pause is uncounted too,
     but nobody agreed how long it would last, so it is not in here - inventing
     a deadline for it would be putting words in the user's mouth. */
  var RESTING = {
    BREAK: { label: 'Break', icon: '☕', allowance: 'breakAlertMinutes' },
    LUNCH: { label: 'Lunch', icon: '🍱', allowance: 'lunchAlertMinutes' }
  };

  function clock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function shortMs(ms) {
    var mins = Math.max(0, Math.round(ms / 60000));
    var h = Math.floor(mins / 60);
    return h > 0 ? h + 'h ' + (mins % 60) + 'm' : mins + 'm';
  }

  /** Work and meetings are credited; a break, a lunch and a pause are not. */
  function counting(state) {
    return state === 'WORKING' || state === 'MEETING';
  }

  /**
   * Credited time as it stands at `now`: what was banked before this segment
   * began, plus the segment itself if it is the sort that counts.
   *
   * Also what the worker uses to bank a finished segment when it settles a break
   * from the shade - the same sum, evaluated at the moment of the tap.
   */
  function creditedAt(snap, now) {
    var banked = Number(snap.creditedBeforeMs) || 0;
    if (counting(snap.state)) banked += Math.max(0, now - snap.openSince);
    return banked;
  }

  /** When the user said they would be back, or null if this state has no such time. */
  function dueAt(snap) {
    var rest = RESTING[snap.state];
    if (!rest) return null;
    var minutes = Number(snap[rest.allowance]);
    if (!isFinite(minutes) || minutes <= 0) return null;
    return snap.openSince + minutes * 60000;
  }

  function title(snap) {
    var rest = RESTING[snap.state];
    if (rest) {
      var due = dueAt(snap);
      return rest.icon + ' ' + rest.label +
        (due ? ' · back by ' + clock(due) : ' · since ' + clock(snap.openSince));
    }
    return TITLES[snap.state] || '⏱️ Track8';
  }

  function body(snap, now) {
    if (snap.state === 'PAUSED') return 'Paused at ' + clock(snap.openSince) + '. Not counting.';

    if (RESTING[snap.state]) {
      var due = dueAt(snap);
      return 'Started ' + clock(snap.openSince) +
        (due ? ', due back ' + clock(due) : '') + '. Not counting.';
    }

    return shortMs(creditedAt(snap, now == null ? Date.now() : now)) +
      ' counted today. Since ' + clock(snap.openSince) + '.';
  }

  /** Null for a state that has no pinned notification at all. */
  function actions(snap) {
    return ACTIONS[snap.state] || null;
  }

  /** Everything showNotification wants apart from the title. */
  function options(snap, now) {
    return {
      body: body(snap, now),
      tag: TAG,
      renotify: false,
      requireInteraction: true,
      silent: true,
      badge: './icons/badge-72.png',
      icon: './icons/icon-192.png',
      data: { kind: 'ongoing', state: snap.state, since: snap.openSince },
      actions: actions(snap)
    };
  }

  global.T8Shift = {
    TAG: TAG,
    title: title,
    body: body,
    actions: actions,
    options: options,
    counting: counting,
    creditedAt: creditedAt,
    shortMs: shortMs,
    clock: clock
  };
})(typeof window !== 'undefined' ? window : self);
