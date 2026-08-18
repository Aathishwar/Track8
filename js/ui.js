/**
 * Track8 - Rendering
 *
 * All DOM writing lives here. Split into a cheap per-second path (the ring and
 * the digits, which are the only things that change while a shift runs) and
 * expensive paths for the week, calendar and profile views that only run when
 * their underlying data actually changed.
 *
 * The previous version rebuilt the whole calendar and rewrote all of storage
 * once per second, which is a real battery cost on a phone that is meant to be
 * sitting in a pocket.
 */
(function (global) {
  'use strict';

  var TL = global.T8Timeline;
  var Store = global.T8Store;

  var RING_RADIUS = 92;
  var CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  var el = {};

  var STATE_LABEL = {
    IDLE: 'Ready to start',
    WORKING: 'Working',
    MEETING: 'In a meeting',
    BREAK: 'On short break',
    LUNCH: 'On lunch',
    PAUSED: 'Paused',
    ENDED: 'Day complete'
  };

  var STATE_CLASS = {
    IDLE: 'status-idle',
    WORKING: 'status-working',
    MEETING: 'status-meeting',
    BREAK: 'status-break',
    LUNCH: 'status-lunch',
    PAUSED: 'status-paused',
    ENDED: 'status-finished'
  };

  /**
   * Caption above the dial's digits, naming what the digits are counting.
   *
   * Distinct from STATE_LABEL, which is the status pill's wording: the pill
   * describes the user ("On lunch"), this describes the number ("Lunch").
   */
  var DIAL_LABEL = {
    IDLE: 'On the clock',
    WORKING: 'On the clock',
    MEETING: 'In a meeting',
    BREAK: 'Short break',
    LUNCH: 'Lunch',
    PAUSED: 'Paused',
    ENDED: 'Day total'
  };

  // States where the digits count the current segment rather than the day.
  // ENDED and IDLE are not here: there is no segment running.
  var SEGMENT_STATES = { BREAK: true, LUNCH: true, MEETING: true, PAUSED: true };

  // Bottom to top in a week bar: the two credited kinds first, so the goal
  // line sits on top of exactly the time it measures.
  var STACK_ORDER = [
    { key: 'workMs', klass: 'seg-work', label: 'Work' },
    { key: 'meetingMs', klass: 'seg-meeting', label: 'Meetings' },
    { key: 'breakMs', klass: 'seg-break', label: 'Breaks' },
    { key: 'lunchMs', klass: 'seg-lunch', label: 'Lunch' }
  ];

  /* ------------------------------------------------------------ formatting */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** HH:MM:SS for the main stopwatch readout. */
  function hms(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  /** "5:42" — a countdown that visibly moves every second. Hours if it needs them. */
  function ms(value) {
    var total = Math.max(0, Math.round(value / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }

  /** "6h 32m" for totals people read rather than watch. */
  function hm(ms) {
    var total = Math.max(0, Math.floor(ms / 60000));
    return Math.floor(total / 60) + 'h ' + String(total % 60).padStart(2, '0') + 'm';
  }

  /** "8h" / "7h 30m" — for tight labels where "8h 00m" is noise. */
  function compactHours(ms) {
    var total = Math.max(0, Math.floor(ms / 60000));
    var h = Math.floor(total / 60);
    var m = total % 60;
    return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
  }

  /**
   * "8h" / "7.5h" — one decimal, for a calendar cell about 44px wide.
   *
   * "7h 30m" does not fit there and wrapping it over two lines would make the
   * grid taller than it is wide. A tenth of an hour is six minutes, which is
   * the right resolution for a month at a glance; the exact figure is one tap
   * away in the day details.
   */
  function cellHours(ms) {
    var hours = Math.max(0, ms) / 3600000;
    var text = hours.toFixed(1);
    if (text.slice(-2) === '.0') text = text.slice(0, -2);
    return text + 'h';
  }

  /** "32m" / "1h 04m" for short durations like breaks. */
  function shortDuration(ms) {
    var minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 60) return minutes + 'm';
    return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
  }

  function clockTime(ms) {
    if (!ms) return '--:--';
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** Signed balance against a target, e.g. "+1h 15m" or "-45m". */
  function signedBalance(ms) {
    var sign = ms < 0 ? '-' : '+';
    return sign + shortDuration(Math.abs(ms));
  }

  function targetMs() {
    return Store.settings().dailyTargetMinutes * 60000;
  }

  /**
   * Never measure a day past the point it stops accruing.
   *
   * A shift someone forgot to end last Tuesday must report Tuesday's hours up
   * to the 10 pm auto-close, not every hour since. Every reader of a stored day
   * goes through this - the timer, the week bars, the calendar, the day sheet,
   * the recovery banner and the correction form - and the Excel export applies
   * the same rule in report.js. Miss one and that screen alone shows 30h.
   */
  function clampToDay(day, now) {
    return TL.measuredAt(day, now);
  }

  /* ---------------------------------------------------------- DOM caching */

  function cache() {
    [
      'appRoot', 'brandLogo', 'brandTargetBadge', 'personSelectBtn', 'headerAvatar', 'currentPersonName',
      'personDropdown', 'personList', 'openAddPersonModal', 'notifyBtn', 'notifyDot', 'themeBtn',
      'viewTimer', 'viewWeek', 'viewCalendar',
      'currentDayName', 'currentFullDate', 'statusPill', 'statusText',
      'progressRingFill', 'timerCenter', 'timerLabel', 'timerDigits', 'dialChip', 'timerAnnouncement',
      'percentageBadge', 'breakDurationText', 'lunchDurationText', 'pausedDurationText',
      'breakBanner', 'breakBannerTitle', 'breakBannerMeta', 'breakBannerAction',
      'reminderStatus', 'meetingDurationText',
      'btnStart', 'btnResume', 'btnBreak', 'btnLunch', 'btnPause', 'btnEnd',
      'btnMeeting', 'btnLogMeeting', 'btnEndMeeting', 'btnEndMeetingText',
      'btnReopen', 'btnEditToday',
      'clockInText', 'clockOutText',
      'openShiftBanner', 'openShiftText', 'openShiftEndBtn', 'openShiftDismissBtn',
      'weeklyAverageText', 'histogramBars', 'weekDonut', 'weekRangeText', 'weekHeading',
      'weekTotalText', 'weekTargetText', 'weekBalanceText',
      'prevWeekBtn', 'nextWeekBtn', 'thisWeekBtn', 'thisMonthBtn',
      'calendarMonthTitle', 'calendarDays', 'prevMonthBtn', 'nextMonthBtn',
      'monthDaysText', 'monthTotalText', 'monthBalanceText',
      'addPersonModal', 'addPersonForm', 'personNameInput', 'personRoleInput',
      'closeAddPersonModal', 'cancelAddPerson',
      'logDetailsModal', 'logModalTitle', 'logDetailsBody', 'closeLogDetailsModal',
      'editDayModal', 'editDayForm', 'editDayTitle', 'closeEditDayModal',
      'editStartTime', 'editEndTime', 'editStillRunning', 'editStillRunningRow', 'editSpanHint',
      'editWorkH', 'editWorkM', 'editMeetingM', 'editBreakM', 'editLunchM', 'editPausedM',
      'editNote', 'deleteDayBtn', 'cancelEditDay',
      'settingsModal', 'closeSettingsModal', 'openSettingsBtn', 'settingsBody',
      'settingsTitle', 'showAllSettingsBtn',
      'setDailyTarget', 'setBreakAlert', 'setBreakRepeat', 'setLunchAlert', 'setLunchRepeat',
      'setStretchAlert', 'setStretchRepeat', 'setPauseAlert', 'setMeetingAlert',
      'setOvertimeReminder', 'sumTimers',
      'setKeepAlive', 'setVibrate', 'notifyStatusText', 'enableNotifyBtn', 'testNotifyBtn',
      'permCard', 'permTitle', 'permSteps', 'permSite', 'permSiteUrl', 'copySiteBtn', 'recheckNotifyBtn',
      'keepAliveWarning', 'batterySteps', 'vibrateNote', 'pushStatus',
      'sumReminders', 'sumProfile', 'sumInstall', 'sumAccount', 'sumAppearance',
      'sumData', 'dataScopeNote',
      'signinScreen', 'signinEmailForm', 'signinCodeForm', 'signinEmail', 'signinCode', 'signinName',
      'signinSendBtn', 'signinVerifyBtn', 'signinResendBtn', 'signinBackBtn',
      'signinSentTo', 'signinError',
      'syncStatusText', 'syncNowBtn', 'signOutBtn', 'changeEmailBtn',
      'emailChangePanel', 'newEmailInput', 'newEmailCode', 'newEmailCodeGroup',
      'sendNewEmailCodeBtn', 'confirmNewEmailBtn', 'cancelEmailChangeBtn', 'emailChangeNote',
      'renamePersonInput', 'renamePersonRole', 'savePersonBtn', 'deletePersonBtn',
      'exportExcelBtn', 'exportBtn', 'importBtn', 'importFileInput', 'installBtn', 'installHint',
      'progressRingContainer', 'toastHost',
      'tourOverlay', 'tourSpotlight', 'tourCard', 'tourCount', 'tourTitle', 'tourText',
      'tourSkipBtn', 'tourNextBtn', 'replayTourBtn',
      'dialToggle', 'dialHourglass', 'restTrack', 'restFill',
      'setupModal', 'setupTarget', 'setupBreak', 'setupLunch', 'setupSaveBtn', 'setupSkipBtn'
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
    return el;
  }

  /* ------------------------------------------------------------- feedback */

  var toastTimer = null;

  function toast(message, kind) {
    if (!el.toastHost) return;
    el.toastHost.textContent = message;
    el.toastHost.className = 'toast show ' + (kind || 'info');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toastHost.className = 'toast';
    }, 3200);
  }

  /* ------------------------------------------------------------ timer view */

  var lastAnnouncement = '';

  /**
   * Update the screen-reader live region, but only when something a listener
   * would care about changes: the status, or the whole minute. The visible
   * digits tick every second and are aria-hidden precisely so this can stay
   * quiet in between.
   */
  function announce(state, creditedMs, openMs) {
    if (!el.timerAnnouncement) return;
    var text = (STATE_LABEL[state] || 'Ready to start') + ', ';
    // Mirrors the dial: when the digits count a segment, say the segment first,
    // then the day, so the spoken reading and the visible one agree.
    if (SEGMENT_STATES[state]) text += hm(openMs) + ' so far, ';
    text += hm(creditedMs) + ' of ' + hm(targetMs());
    if (text === lastAnnouncement) return;
    lastAnnouncement = text;
    el.timerAnnouncement.textContent = text;
  }

  // Which day has already had its "target reached" flourish. Keyed by date so
  // the animation plays once per day and not once per second thereafter, and
  // so it plays again tomorrow.
  var celebratedKey = null;

  function celebrateOnce(node, reached, dateKey) {
    if (!reached) {
      // Dropping below target again (a correction, or a reopened day) re-arms
      // the flourish rather than silently spending it.
      if (celebratedKey === dateKey) celebratedKey = null;
      return;
    }
    if (celebratedKey === dateKey) return;
    celebratedKey = dateKey;

    node.classList.remove('celebrate');
    // Force a reflow so the class re-add restarts the animation. One layout
    // read, once a day, on a 220px box.
    void node.offsetWidth;
    node.classList.add('celebrate');
    setTimeout(function () { node.classList.remove('celebrate'); }, 1000);
  }

  // Which state the dial centre was last built for. The swap animation plays
  // on a change of activity, not on the per-second tick that follows it.
  var lastDialState = null;

  /**
   * The reminder limit and repeat interval for a resting state, or null when
   * the state has no reminder attached to it.
   */
  function restLimits(state) {
    var settings = Store.settings();
    if (state === 'LUNCH') {
      return { limit: settings.lunchAlertMinutes * 60000, repeat: settings.lunchRepeatMinutes * 60000 };
    }
    if (state === 'BREAK') {
      return { limit: settings.breakAlertMinutes * 60000, repeat: settings.breakRepeatMinutes * 60000 };
    }
    return null;
  }

  /**
   * The three things inside the ring: caption, digits, and the chip beside the
   * percentage.
   *
   * On a break, at lunch, in a meeting or paused, the digits count that
   * segment - which is the number the user actually wants then, and the reason
   * this exists: it used to be legible only in the small banner below the
   * dial. The percentage keeps its own meaning throughout, because the ring it
   * annotates is always the day.
   */
  var lastSand = null;
  var lastDialMode = null;

  var REST_RADIUS = 80;
  var REST_CIRCUMFERENCE = 2 * Math.PI * REST_RADIUS;
  var lastRestSince = null;
  var lastRestLap = -1;

  // Three laps and no more. Past that the ring says the same thing every lap -
  // "you are a very long way over" - and a counter nobody reads is worse than
  // a ring that has visibly stopped caring.
  var REST_MAX_LAPS = 3;

  /**
   * The inner arc: this break, against the allowance the user set.
   *
   * One full lap *is* the allowance, so the ring closing is the reminder
   * landing. Going over starts a second lap in a hotter colour, and a third is
   * where it stops - the shape carries "how far over" without a number.
   */
  function renderRestArc(summary) {
    if (!el.restFill || !el.restTrack) return;

    var settings = Store.settings();
    var allowanceMinutes = 0;
    if (summary.state === 'BREAK') allowanceMinutes = settings.breakAlertMinutes;
    else if (summary.state === 'LUNCH') allowanceMinutes = settings.lunchAlertMinutes;
    else if (summary.state === 'PAUSED') allowanceMinutes = settings.pauseAlertMinutes;

    // setAttribute, not `.hidden`. `hidden` is defined on HTMLElement and these
    // two are SVGElements, so `el.restFill.hidden = false` quietly created a
    // property on the object and left the attribute - and therefore the
    // `[hidden] { display: none }` rule - exactly where it was. The arc was
    // never once painted, and a check that read the same property back read the
    // value it had just written and called it a pass.
    if (!allowanceMinutes || allowanceMinutes <= 0) {
      el.restFill.setAttribute('hidden', '');
      el.restTrack.setAttribute('hidden', '');
      lastRestSince = null;
      lastRestLap = -1;
      return;
    }

    el.restFill.removeAttribute('hidden');
    el.restTrack.removeAttribute('hidden');
    el.restTrack.style.strokeDasharray = REST_CIRCUMFERENCE;

    // A new break: play the sweep-up once. Keyed on the moment the segment
    // began, so a reload mid-break adopts it without re-animating.
    if (lastRestSince !== summary.openSince) {
      lastRestSince = summary.openSince;
      lastRestLap = -1;
      el.restFill.classList.remove('arming');
      void el.restFill.getBoundingClientRect().width;
      el.restFill.classList.add('arming');
    }

    var ratio = summary.openMs / (allowanceMinutes * 60000);
    var lap = Math.min(REST_MAX_LAPS - 1, Math.floor(ratio));
    var withinLap = lap >= REST_MAX_LAPS - 1 ? Math.min(1, ratio - lap) : ratio - lap;

    el.restFill.style.strokeDasharray = REST_CIRCUMFERENCE;
    el.restFill.style.strokeDashoffset = REST_CIRCUMFERENCE - REST_CIRCUMFERENCE * withinLap;

    // Each lap is a step hotter. The transition has to be cut for the frame the
    // lap rolls over on, or the arc animates backwards around the whole circle
    // to reach its new starting point.
    if (lap !== lastRestLap) {
      lastRestLap = lap;
      el.restFill.classList.add('lap-reset');
      global.setTimeout(function () { el.restFill.classList.remove('lap-reset'); }, 60);
    }
    el.restFill.classList.toggle('lap-2', lap === 1);
    el.restFill.classList.toggle('lap-3', lap >= 2);
  }

  var lastSand = null;
  var lastDialMode = null;

  // One entry per digit card: where it reads from in the clock string, its face
  // node, what it currently shows, and which of the two flip animations is
  // armed next.
  var flipCells = null;
  var flipLength = 0;

  /**
   * Build the split-flap cards for a clock string of `text.length` characters.
   *
   * Rebuilt only when the shape changes - which is once, at first paint, and
   * again only if an hour count ever needs a third digit. Everything after that
   * is a text write on the cards that actually changed.
   */
  /**
   * The bottom half keeps the *old* digit for the length of the fall - it is
   * the half the flap is landing on, and swapping it early is what makes a
   * split-flap read as two different numbers at once. It catches up when the
   * flap lands.
   *
   * A function rather than a closure written inside the build loop: this file
   * is ES5-flavoured, `var` is function-scoped, and every handler declared in
   * that loop closed over the *same* variable - so five of the six cards never
   * caught up and stayed a digit behind for good. A parameter gives each card
   * its own binding.
   *
   * `animationcancel` matters as much as `animationend`: a change arriving
   * mid-fall replaces the animation instead of finishing it.
   */
  function armFlipLanding(cell) {
    var land = function () { cell.bottom.textContent = cell.value; };
    cell.node.addEventListener('animationend', land);
    cell.node.addEventListener('animationcancel', land);
  }

  function flipHalf(className, ch) {
    var half = document.createElement('span');
    half.className = className;
    var glyph = document.createElement('i');
    glyph.textContent = ch;
    half.appendChild(glyph);
    return half;
  }

  function buildFlipClock(text) {
    el.timerDigits.textContent = '';
    flipCells = [];
    flipLength = text.length;

    // Position of the second colon: everything after it is the seconds pair,
    // which is rendered small.
    var secondsFrom = text.lastIndexOf(':');

    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);

      if (ch === ':') {
        var sep = document.createElement('span');
        sep.className = 'fd-sep';
        sep.textContent = ':';
        el.timerDigits.appendChild(sep);
        continue;
      }

      var card = document.createElement('span');
      card.className = 'fd' + (secondsFrom > -1 && i > secondsFrom ? ' fd-sm' : '');

      var top = flipHalf('fd-half fd-top', ch);
      var bottom = flipHalf('fd-half fd-bottom', ch);

      var flap = document.createElement('span');
      flap.className = 'fd-flap';
      var front = flipHalf('fd-face fd-front', ch);
      var back = flipHalf('fd-face fd-back', ch);
      flap.appendChild(front);
      flap.appendChild(back);

      card.appendChild(top);
      card.appendChild(bottom);
      card.appendChild(flap);
      el.timerDigits.appendChild(card);

      var cell = {
        index: i, node: card, value: ch, alt: false,
        top: top.firstChild, bottom: bottom.firstChild,
        front: front.firstChild, back: back.firstChild
      };

      armFlipLanding(cell);
      flipCells.push(cell);
    }
  }

  /**
   * Write a clock string, flipping only the cards whose digit changed.
   *
   * On a normal tick that is one card; on a minute boundary, two or three. The
   * cost of the whole clock is therefore a couple of text writes and a class
   * swap per second, which is what the old single textContent cost.
   */
  function renderFlipClock(text) {
    if (!el.timerDigits) return;
    if (!flipCells || flipLength !== text.length) buildFlipClock(text);

    for (var i = 0; i < flipCells.length; i++) {
      var cell = flipCells[i];
      var ch = text.charAt(cell.index);
      if (ch === cell.value) continue;

      // The flap's front keeps the digit that is leaving - it is the half the
      // eye is still looking at as it starts to fall - and so does the bottom
      // half underneath it. The top and the flap's back take the new digit; the
      // bottom follows when the flap lands on it.
      cell.front.textContent = cell.value;
      cell.top.textContent = ch;
      cell.back.textContent = ch;
      cell.value = ch;

      cell.node.classList.remove(cell.alt ? 'flip-b' : 'flip-a');
      cell.alt = !cell.alt;
      cell.node.classList.add(cell.alt ? 'flip-b' : 'flip-a');
    }
  }

  /**
   * Sand level of the little hourglass, as the fraction of the day still owed.
   *
   * Written at most once per whole percent rather than once per second: this
   * runs on the tick path, and a custom-property write is a style recalc even
   * when the value is unchanged.
   */
  function renderHourglass(remainingRatio) {
    if (!el.dialHourglass) return;
    var sand = Math.round(Math.max(0, Math.min(1, remainingRatio)) * 100) / 100;
    if (sand === lastSand) return;
    lastSand = sand;
    el.dialHourglass.style.setProperty('--sand', sand);
    el.dialHourglass.style.setProperty('--sand-done', 1 - sand);
  }

  /**
   * Swap the dial between hours worked and hours left.
   *
   * Kept in settings rather than in a variable so it survives a reload - the
   * whole point is that someone who only ever wants the countdown gets it
   * without tapping again every morning.
   */
  function toggleDialMode() {
    var next = !(Store.settings().dialShowsRemaining === true);
    Store.updateSettings({ dialShowsRemaining: next });

    if (el.dialHourglass) {
      el.dialHourglass.classList.remove('flip');
      // getBoundingClientRect, not offsetWidth: this is an SVG element, and
      // SVGElement has no offsetWidth at all - the read was `void undefined`,
      // no reflow was forced, and the animation replayed exactly once ever.
      void el.dialHourglass.getBoundingClientRect().width;
      el.dialHourglass.classList.add('flip');
    }

    return next;
  }

  function renderDialCenter(summary) {
    var state = summary.state;
    var inSegment = SEGMENT_STATES[state] === true;

    // The caption, the chip and the swap container all arrived with this
    // release; the digits did not. Against an index.html that predates it -
    // which a rolling deploy can serve for a few seconds - the clock keeps
    // running and only the new parts sit out. Unguarded this threw once per
    // second, on the one path that must never stop.
    var target = targetMs();
    var remainingMs = Math.max(0, target - summary.creditedMs);
    var showsRemaining = Store.settings().dialShowsRemaining === true;

    // The button's own state, applied here rather than in the toggle so a
    // reload lands on the right label too. Guarded because this is the tick
    // path and the mode changes about once a week.
    if (showsRemaining !== lastDialMode) {
      lastDialMode = showsRemaining;
      if (el.dialToggle) {
        el.dialToggle.setAttribute('aria-pressed', showsRemaining ? 'true' : 'false');
        el.dialToggle.setAttribute('aria-label', showsRemaining
          ? 'Dial shows hours left. Tap to show hours worked.'
          : 'Dial shows hours worked. Tap to show hours left.');
      }
    }

    if (showsRemaining) {
      // One tap turns the dial into the countdown. It answers the day's other
      // question - "when can I stop?" - from the same digits, so nothing else
      // on the glance screen has to grow a second row to hold it.
      if (el.timerLabel) el.timerLabel.textContent = remainingMs > 0 ? 'Hours left' : 'Goal met';
      renderFlipClock(hms(remainingMs));
    } else {
      if (el.timerLabel) el.timerLabel.textContent = DIAL_LABEL[state] || DIAL_LABEL.IDLE;
      renderFlipClock(hms(inSegment ? summary.openMs : summary.creditedMs));
    }

    renderHourglass(target > 0 ? remainingMs / target : 0);
    renderRestArc(summary);

    // The chip is what the banner below used to spell out. Under the limit it
    // is the countdown; over it, the overrun - so the dial alone answers "am I
    // running long?" and the banner is free to appear only when the answer is
    // yes.
    var chip = '';
    var over = false;
    var limits = restLimits(state);

    if (limits) {
      // Counted down in mm:ss, not in whole minutes. "reminder in 5m" sits
      // there unchanged for sixty seconds beside a ring that moves less than
      // half a degree in that time, and the pair of them look frozen - which is
      // exactly what a break timer must never look like.
      if (summary.openMs < limits.limit) {
        chip = 'back in ' + ms(limits.limit - summary.openMs);
      } else {
        chip = ms(summary.openMs - limits.limit) + ' over';
        over = true;
      }
    } else if (state === 'MEETING') {
      // Meetings are credited, so the day total is still moving; showing it
      // here keeps the figure the digits gave up.
      chip = hm(summary.creditedMs) + ' today';
    } else if (state === 'PAUSED') {
      chip = 'not counting';
    }

    if (el.dialChip) {
      el.dialChip.hidden = chip === '';
      el.dialChip.textContent = chip;
      el.dialChip.classList.toggle('over', over);
    }

    // Replay the swap only when the activity changed. renderTimer runs every
    // second, and re-running it on each tick would leave the centre of the
    // screen permanently animating.
    if (state !== lastDialState) {
      lastDialState = state;
      if (el.timerCenter) {
        el.timerCenter.classList.remove('swap');
        // One layout read, once per state change, to restart the animation.
        void el.timerCenter.offsetWidth;
        el.timerCenter.classList.add('swap');
      }
    }
  }

  /**
   * The per-second path. Touches text nodes and one stroke offset, nothing
   * more; no storage writes, no list rebuilds.
   */
  function renderTimer(day, now) {
    var summary = TL.summarize(day, clampToDay(day, now));
    var target = targetMs();
    var state = summary.state;

    renderDialCenter(summary);

    el.meetingDurationText.textContent = shortDuration(summary.meetingMs);
    el.breakDurationText.textContent = shortDuration(summary.breakMs);
    el.lunchDurationText.textContent = shortDuration(summary.lunchMs);
    el.pausedDurationText.textContent = shortDuration(summary.pausedMs);
    el.clockInText.textContent = clockTime(summary.firstIn);
    el.clockOutText.textContent = clockTime(summary.lastOut);

    var ratio = target > 0 ? summary.creditedMs / target : 0;
    var percent = Math.round(ratio * 100);
    el.percentageBadge.textContent = percent + '%';
    el.percentageBadge.classList.toggle('over', ratio > 1);

    var shown = Math.min(1, ratio);
    var resting = state === 'BREAK' || state === 'LUNCH' || state === 'PAUSED';
    el.progressRingFill.style.strokeDasharray = CIRCUMFERENCE;
    el.progressRingFill.style.strokeDashoffset = CIRCUMFERENCE - CIRCUMFERENCE * shown;
    el.progressRingFill.classList.toggle('complete', ratio >= 1);
    el.progressRingFill.classList.toggle('meeting', state === 'MEETING');
    el.progressRingFill.classList.toggle('resting', resting);
    // Lunch and pause take their own colours rather than borrowing the break's
    // amber, so the ring agrees with the caption inside it and with every other
    // place the app paints these activities.
    el.progressRingFill.classList.toggle('lunch', state === 'LUNCH');
    el.progressRingFill.classList.toggle('paused', state === 'PAUSED');

    // The halo behind the ring is a static gradient, lit only while a shift is
    // actually running, and recoloured to match the stroke.
    if (el.progressRingContainer) {
      var ring = el.progressRingContainer;
      ring.classList.toggle('lit', state !== 'IDLE');
      ring.classList.toggle('tone-meeting', state === 'MEETING');
      ring.classList.toggle('tone-resting', resting);
      ring.classList.toggle('tone-lunch', state === 'LUNCH');
      ring.classList.toggle('tone-paused', state === 'PAUSED');
      // The travelling light runs only while the clock is actually earning, so
      // its presence answers "is this time counting?" without a word. Meetings
      // are credited, so they keep it; break, lunch and pause do not.
      ring.classList.toggle('earning', state === 'WORKING' || state === 'MEETING');
      celebrateOnce(ring, ratio >= 1, day.dateKey);
    }

    el.statusPill.className = 'status-pill ' + (STATE_CLASS[state] || 'status-idle');
    el.statusText.textContent = STATE_LABEL[state] || 'Ready to start';

    announce(state, summary.creditedMs, summary.openMs);
    renderActions(state, TL.previousState(day) === TL.STATES.ENDED);
    renderBreakBanner(summary);

    return summary;
  }

  /**
   * One button per intention, shown only when it applies.
   *
   * The old single toggle meant "Pause Work" silently logged a coffee break.
   * Break, lunch and pause are now separate transitions with separate buckets,
   * and every button is explicitly re-enabled on each render so no state can
   * leave one stuck disabled.
   */
  /**
   * `afterHours` means the current meeting was started once the day had
   * already been ended, so finishing it returns to off-the-clock rather than
   * back to work, and there is no day left to end.
   */
  function renderActions(state, afterHours) {
    var resting = state === 'BREAK' || state === 'LUNCH' || state === 'PAUSED';

    var show = {
      btnStart: state === 'IDLE',
      btnResume: resting,
      btnMeeting: state === 'WORKING',
      btnLogMeeting: state === 'ENDED',
      btnEndMeeting: state === 'MEETING',
      btnBreak: state === 'WORKING',
      btnLunch: state === 'WORKING',
      btnPause: state === 'WORKING',
      btnEnd: state === 'WORKING' || resting || (state === 'MEETING' && !afterHours),
      btnReopen: state === 'ENDED',
      btnEditToday: state === 'ENDED'
    };

    Object.keys(show).forEach(function (id) {
      var node = el[id];
      if (!node) return;
      node.hidden = !show[id];
      // Re-enabled on every render: no state may leave a button stuck off.
      node.disabled = false;
    });

    if (state === 'MEETING') {
      el.btnEndMeetingText.textContent = afterHours ? 'Finish meeting' : 'Meeting over, back to work';
    }

    el.appRoot.setAttribute('data-state', state);
    el.appRoot.setAttribute('data-after-hours', afterHours ? 'yes' : 'no');
  }

  /**
   * The in-app half of the reminder, now shown only once the break has actually
   * run long.
   *
   * It used to sit there for the whole break restating the elapsed time and the
   * countdown. Both of those are in the dial now, where the eye already is, so
   * a permanent banner was a second copy occupying the scarcest space on the
   * one screen that has to fit without scrolling. Appearing only on the overrun
   * also makes it mean something when it does appear. Ending a break never
   * depended on it: "Back to work" is in the button grid in every resting
   * state.
   */
  function renderBreakBanner(summary) {
    var resting = summary.state === 'BREAK' || summary.state === 'LUNCH';
    var limits = resting ? restLimits(summary.state) : null;
    var over = limits ? summary.openMs - limits.limit : -1;

    el.breakBanner.hidden = !limits || over < 0;
    if (el.breakBanner.hidden) return;

    var isLunch = summary.state === 'LUNCH';
    el.breakBanner.classList.add('over');
    el.breakBannerAction.textContent = 'End ' + (isLunch ? 'lunch' : 'break');
    el.breakBannerTitle.textContent = (isLunch ? 'Lunch' : 'Break') + ' running long';

    var nextIn = limits.repeat - (over % limits.repeat);
    el.breakBannerMeta.textContent = shortDuration(over) + ' over ' +
      shortDuration(limits.limit) + ' · next nudge in ' + shortDuration(nextIn);
  }

  /**
   * Plain-language summary of which reminder layers are actually live.
   *
   * Shown only when it says something the user can act on. When reminders are
   * simply working, the line was restating the bell icon in three lines of
   * body text at the bottom of the one screen that has to fit without
   * scrolling — the bell's own lit state already carries "reminders are on".
   */
  function renderReminderStatus(notify) {
    if (!el.reminderStatus) return;

    var permission = notify.permission();
    var healthy = notify.supported() && permission === 'granted' && notify.hasServiceWorker();
    var message = '';

    // A server reminder does not care whether the page survives, so a phone
    // with push working is fully covered and the line stays hidden.
    var push = global.T8Push ? global.T8Push.status() : { active: false };
    healthy = healthy || (push.active && permission === 'granted');

    if (!notify.supported()) {
      message = 'This browser cannot show notifications. In-app reminders only.';
    } else if (permission === 'granted' && !notify.hasServiceWorker()) {
      message = 'Reminders are limited - open the app from a web address, not a file, for background reminders.';
    } else if (permission === 'denied') {
      message = 'Notifications are blocked, so you are only reminded while the app is open. Settings shows how to switch them back on.';
    } else if (permission !== 'granted') {
      message = 'Notifications are off. Tap the bell to turn on break reminders.';
    }

    el.reminderStatus.textContent = message;
    el.reminderStatus.hidden = healthy;

    el.notifyDot.hidden = permission !== 'granted';
    el.notifyBtn.classList.toggle('enabled', permission === 'granted');
  }

  /**
   * Prompt shown when a previous day was left running.
   *
   * The elapsed total is clamped to that day's own midnight. Reading it up to
   * "now" would claim every hour since, which is exactly the invented-time
   * problem this prompt exists to let the user correct.
   */
  function renderOpenShiftBanner(openDay) {
    el.openShiftBanner.hidden = !openDay;
    if (!openDay) return;

    var summary = TL.summarize(openDay, clampToDay(openDay, Date.now()));
    var when = TL.dateFromKey(openDay.dateKey)
      .toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

    el.openShiftText.textContent = openDay.autoEnded
      ? when + ' was never ended, so it was closed at 10pm and counts ' + hm(summary.creditedMs) +
        '. Set the real hours, or tap Looks right to keep it.'
      : 'You never ended ' + when + '. It shows ' + hm(summary.creditedMs) +
        ' so far - set the real hours so your totals stay honest.';

    el.openShiftDismissBtn.textContent = openDay.autoEnded ? 'Looks right' : 'Later';
    el.openShiftBanner.dataset.dateKey = openDay.dateKey;
  }

  /* ------------------------------------------------------------ week view */

  /* The week runs Sunday to Saturday. Both charts, the calendar grid and the
     week's arrows all read this, so it is the only place the choice is made. */
  function startOfWeek(date) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - d.getDay()); // Sunday = 0, which getDay() already is
    return d;
  }

  var lastWeekKey = null;


  // Slice order matters: the two credited kinds first, so the counted portion
  // of the week is one continuous sweep rather than two pieces with breaks
  // wedged between them.
  var DONUT_PARTS = [
    { key: 'workMs', klass: 'dn-work', label: 'Work' },
    { key: 'meetingMs', klass: 'dn-meeting', label: 'Meetings' },
    { key: 'breakMs', klass: 'dn-break', label: 'Breaks' },
    { key: 'lunchMs', klass: 'dn-lunch', label: 'Lunch' }
  ];

  var DONUT_RADIUS = 50;
  var DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
  // A hairline of background between slices, so two adjacent colours read as
  // two values rather than one gradient. Taken off the drawn dash only - the
  // running offset still advances by the full share, or the ring would come up
  // short by one gap per slice and stop meaning one hundred per cent.
  var DONUT_GAP = 3;

  /**
   * Where the week's logged time went, as one hundred per cent.
   *
   * Built from stroke-dasharray on concentric circles rather than from arc
   * paths: four dash lengths and four offsets, no trigonometry, and the browser
   * draws the joins. Percentages are printed beside it because a reader cannot
   * tell 9% from 12% by angle, and those two are exactly the ones people want
   * to compare.
   */
  function renderWeekDonut(entries) {
    if (!el.weekDonut) return;

    var totals = DONUT_PARTS.map(function (part) {
      return entries.reduce(function (sum, e) { return sum + (e.summary[part.key] || 0); }, 0);
    });
    var total = totals.reduce(function (sum, ms) { return sum + ms; }, 0);

    if (total <= 0) {
      el.weekDonut.innerHTML = '<p class="dn-empty">Nothing logged this week yet.</p>';
      return;
    }

    var offset = 0;
    var slices = '';
    var rows = '';
    var visible = totals.filter(function (ms) { return ms > 0; }).length;

    DONUT_PARTS.forEach(function (part, i) {
      var value = totals[i];
      if (value <= 0) return;
      var share = value / total;
      var length = share * DONUT_CIRCUMFERENCE;
      // A single slice is a whole ring and must close; a sliver thinner than the
      // gap would otherwise disappear entirely, so it keeps a visible stub.
      var drawn = visible < 2 ? length : Math.max(1.5, length - DONUT_GAP);

      slices +=
        '<circle class="dn-slice ' + part.klass + '" cx="60" cy="60" r="' + DONUT_RADIUS + '"' +
        ' stroke-dasharray="' + drawn.toFixed(2) + ' ' + (DONUT_CIRCUMFERENCE - drawn).toFixed(2) + '"' +
        ' stroke-dashoffset="' + (-offset).toFixed(2) + '"></circle>';
      offset += length;

      rows +=
        '<li class="dn-row">' +
          '<span class="swatch ' + part.klass + '" aria-hidden="true"></span>' +
          '<span class="dn-label">' + part.label + '</span>' +
          '<span class="dn-pct">' + Math.round(share * 100) + '%</span>' +
          '<span class="dn-time">' + hm(value) + '</span>' +
        '</li>';
    });

    var creditedShare = (totals[0] + totals[1]) / total;

    el.weekDonut.innerHTML =
      '<div class="dn-chart">' +
        '<svg viewBox="0 0 120 120" aria-hidden="true">' +
          '<circle class="dn-track" cx="60" cy="60" r="' + DONUT_RADIUS + '"></circle>' +
          slices +
        '</svg>' +
        '<span class="dn-centre"><strong>' + Math.round(creditedShare * 100) + '%</strong><small>counted</small></span>' +
      '</div>' +
      '<ul class="dn-legend">' + rows + '</ul>';
  }

  function renderWeek(weekAnchor, now) {
    var days = Store.daysOf();
    var weekStart = startOfWeek(weekAnchor);
    var labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var target = targetMs();
    var todayKey = TL.dateKeyOf(now);

    var entries = labels.map(function (label, i) {
      var d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
      var key = TL.dateKeyOf(d);
      var day = days[key];
      var summary = day
        ? TL.summarize(day, clampToDay(day, now))
        : { workMs: 0, meetingMs: 0, breakMs: 0, lunchMs: 0, creditedMs: 0 };

      return {
        label: label,
        key: key,
        date: d,
        summary: summary,
        // Only the credited portion is measured against the goal; breaks stack
        // above the line because they are not part of the target.
        stackMs: summary.workMs + summary.meetingMs + summary.breakMs + summary.lunchMs,
        isToday: key === todayKey,
        isFuture: d.getTime() > now,
        // Sunday is index 0 now and Saturday is 6, so the weekend is the
        // two ends of the row rather than its tail.
        isWeekend: i === 0 || i === 6
      };
    });

    // Scale to the tallest stack so a long day is not silently clipped flat.
    var peak = entries.reduce(function (max, e) { return Math.max(max, e.stackMs); }, 0);
    var scale = Math.max(target * 1.25, peak * 1.1, 1);

    el.histogramBars.innerHTML = '';
    entries.forEach(function (entry) {
      // A button rather than a div: tapping a day opens its log, which is
      // where "Correct this day" lives. Future days hold nothing to open and
      // cannot be corrected in advance, so they are disabled rather than
      // opening an empty sheet.
      var col = document.createElement('button');
      col.type = 'button';
      col.className = 'bar-column' + (entry.isToday ? ' today' : '') + (entry.isFuture ? ' future' : '');
      col.setAttribute('data-date-key', entry.key);
      col.disabled = entry.isFuture;
      col.setAttribute('aria-label',
        entry.date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) +
        ', ' + hm(entry.summary.creditedMs) + ' counted' +
        (entry.isFuture ? '' : '. Open the day'));

      // Rendered top-down inside a bottom-aligned flex column, so the array is
      // reversed: work ends up at the base of the bar.
      var stack = STACK_ORDER.slice().reverse().map(function (part) {
        var ms = entry.summary[part.key] || 0;
        if (ms <= 0) return '';
        var height = Math.min(100, (ms / scale) * 100);
        return '<span class="bar-seg ' + part.klass + '" style="height:' + height.toFixed(2) + '%"></span>';
      }).join('');

      col.innerHTML =
        '<span class="bar-val">' +
        (entry.summary.creditedMs > 0 ? (entry.summary.creditedMs / 3600000).toFixed(1) + 'h' : '') +
        '</span>' +
        '<span class="bar-track"><span class="bar-stack">' + stack + '</span></span>' +
        '<span class="bar-day">' + entry.label + '</span>';

      col.title = entry.date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' }) +
        '\nCounted ' + hm(entry.summary.creditedMs) +
        ' (work ' + hm(entry.summary.workMs) + ', meetings ' + shortDuration(entry.summary.meetingMs) + ')' +
        '\nBreaks ' + shortDuration(entry.summary.breakMs) +
        ', lunch ' + shortDuration(entry.summary.lunchMs);

      el.histogramBars.appendChild(col);
    });

    // Put the goal line on the same scale as the bars rather than at a fixed
    // height, so it stays truthful when the scale stretches for a long day.
    //
    // Only the ratio is published; styles.css turns it into a position against
    // the track band. Setting a pixel offset here instead was wrong in two
    // ways: the track height is a token the stylesheet owns, and the first
    // render happens while the week view is still hidden, so every rect it
    // could have measured reads zero.
    var goalLine = document.querySelector('.target-line-indicator');
    if (goalLine) {
      goalLine.style.setProperty('--goal-ratio', Math.min(1, target / scale).toFixed(4));
      goalLine.querySelector('.target-label').textContent = compactHours(target);
    }

    renderWeekDonut(entries);

    // As with the calendar: replay the entry animation when the week on screen
    // changes, not on every re-render triggered by an unrelated button press.
    var weekKey = TL.dateKeyOf(weekStart);
    el.histogramBars.classList.toggle('animate', weekKey !== lastWeekKey);
    lastWeekKey = weekKey;

    var worked = entries.filter(function (e) { return e.summary.creditedMs > 0; });
    var totalMs = entries.reduce(function (sum, e) { return sum + e.summary.creditedMs; }, 0);
    var avgMs = worked.length ? totalMs / worked.length : 0;

    // Target counts weekdays that have already begun, so Wednesday is not
    // scored against a full five-day week.
    var elapsedWeekdays = entries.filter(function (e) { return !e.isWeekend && !e.isFuture; }).length;
    var weekTarget = elapsedWeekdays * target;

    var weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);
    el.weekRangeText.textContent =
      weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' - ' +
      weekEnd.toLocaleDateString([], { month: 'short', day: 'numeric' });

    // Nothing is recorded ahead of today, so forward stops at the current
    // week and the way back is one tap rather than a count of arrow presses.
    // Both are set here rather than in the click handlers, so every path that
    // re-renders - a resume, a profile switch, midnight rollover - leaves them
    // correct.
    var atCurrent = TL.dateKeyOf(weekStart) === TL.dateKeyOf(startOfWeek(new Date(now)));
    if (el.nextWeekBtn) el.nextWeekBtn.disabled = atCurrent;
    if (el.thisWeekBtn) el.thisWeekBtn.hidden = atCurrent;
    if (el.weekHeading) el.weekHeading.textContent = atCurrent ? 'This week' : 'Past week';

    // No "Avg" prefix: the cell above it is already labelled Average, and the
    // extra word pushed the value onto a second line, making that one cell
    // taller than the other three.
    el.weeklyAverageText.textContent = hm(avgMs) + '/day';
    el.weekTotalText.textContent = hm(totalMs);
    el.weekTargetText.textContent = hm(weekTarget);

    var balance = totalMs - weekTarget;
    el.weekBalanceText.textContent = signedBalance(balance);
    el.weekBalanceText.className = 'summary-value ' + (balance >= 0 ? 'positive' : 'negative');
  }

  /* -------------------------------------------------------- calendar view */

  var lastCalendarMonth = null;

  function renderCalendar(monthAnchor, now) {
    var days = Store.daysOf();
    var year = monthAnchor.getFullYear();
    var month = monthAnchor.getMonth();
    var target = targetMs();
    var todayKey = TL.dateKeyOf(now);

    el.calendarMonthTitle.textContent = monthAnchor.toLocaleDateString([], { month: 'long', year: 'numeric' });

    // Same rule as the week: forward stops at the current month, and getting
    // back is one tap.
    var today = new Date(now);
    var atCurrentMonth = year === today.getFullYear() && month === today.getMonth();
    if (el.nextMonthBtn) el.nextMonthBtn.disabled = atCurrentMonth;
    if (el.thisMonthBtn) el.thisMonthBtn.hidden = atCurrentMonth;

    var firstIndex = new Date(year, month, 1).getDay();
    var totalDays = new Date(year, month + 1, 0).getDate();

    var fragment = document.createDocumentFragment();

    for (var pad = 0; pad < firstIndex; pad++) {
      var empty = document.createElement('div');
      empty.className = 'cal-day-cell empty';
      fragment.appendChild(empty);
    }

    var monthWorkMs = 0;
    var monthDaysWorked = 0;
    var monthTargetMs = 0;

    for (var dayNum = 1; dayNum <= totalDays; dayNum++) {
      var date = new Date(year, month, dayNum);
      var key = TL.dateKeyOf(date);
      var day = days[key];
      var creditedMs = day ? TL.summarize(day, clampToDay(day, now)).creditedMs : 0;
      var isWeekend = date.getDay() === 0 || date.getDay() === 6;
      var isFuture = date.getTime() > now && key !== todayKey;

      if (creditedMs > 0) {
        monthWorkMs += creditedMs;
        monthDaysWorked++;
      }
      if (!isWeekend && !isFuture) monthTargetMs += target;

      var tone = 'dot-off';
      if (creditedMs >= target) tone = 'dot-completed';
      else if (creditedMs > 0) tone = 'dot-partial';
      else if (isFuture) tone = 'dot-future';
      else if (isWeekend) tone = 'dot-weekend';

      var cell = document.createElement('div');
      cell.className = 'cal-day-cell' +
        (key === todayKey ? ' today' : '') +
        (isFuture ? ' future' : '') +
        (isWeekend ? ' weekend' : '');

      // Days that have not happened yet are inert: no data-date-key means the
      // delegated click handler finds nothing, so no empty "add a record"
      // dialog for a date nobody can have worked.
      if (isFuture) {
        cell.setAttribute('aria-disabled', 'true');
      } else {
        cell.setAttribute('role', 'button');
        cell.setAttribute('tabindex', '0');
        cell.setAttribute('aria-label',
          date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) +
          (creditedMs > 0 ? ', ' + hm(creditedMs) + ' logged' : ', no record'));
        cell.dataset.dateKey = key;
      }

      // A worked day shows its hours in place of the dot rather than as well
      // as it: three stacked things in a 44px box is the "overwhelming" the
      // number was meant to avoid. Days with no record keep the dot, so the
      // grid stays quiet exactly where there is nothing to read, and the ink
      // lands only on days that have something to say.
      //
      // The figure is also a second channel for the colour: "6.5h" against an
      // 8h target says short without anyone having to distinguish amber from
      // emerald.
      cell.innerHTML =
        '<span class="cal-day-num">' + dayNum + '</span>' +
        (creditedMs > 0
          ? '<span class="cal-day-hours ' + (creditedMs >= target ? 'met' : 'short') + '">' +
            cellHours(creditedMs) + '</span>'
          : '<span class="cal-status-dot ' + tone + '"></span>');

      // Stagger index for the reveal. Capped so a 31-day month finishes in
      // about a quarter of a second instead of trickling in.
      cell.style.setProperty('--i', Math.min(dayNum, 34));

      fragment.appendChild(cell);
    }

    el.calendarDays.innerHTML = '';
    el.calendarDays.appendChild(fragment);

    // Only stagger when the month on screen actually changed. renderAll() runs
    // on every button press, and re-playing the reveal because someone started
    // a break would be noise.
    var monthId = year + '-' + month;
    el.calendarDays.classList.toggle('animate', monthId !== lastCalendarMonth);
    lastCalendarMonth = monthId;

    el.monthDaysText.textContent = monthDaysWorked + (monthDaysWorked === 1 ? ' day' : ' days');
    el.monthTotalText.textContent = hm(monthWorkMs);

    var balance = monthWorkMs - monthTargetMs;
    el.monthBalanceText.textContent = signedBalance(balance);
    el.monthBalanceText.className = 'summary-value ' + (balance >= 0 ? 'positive' : 'negative');
  }

  /* ------------------------------------------------------------- profiles */

  function renderPersonHeader() {
    var person = Store.activePerson();
    el.currentPersonName.textContent = person.name;
    el.headerAvatar.textContent = person.name.trim().charAt(0).toUpperCase() || '?';
  }

  function renderPersonList() {
    var active = Store.get().activePersonId;
    el.personList.innerHTML = Store.persons().map(function (person) {
      return '<button type="button" class="person-item' + (person.id === active ? ' active' : '') +
        '" data-person-id="' + escapeHtml(person.id) + '">' +
        '<span class="avatar-sm">' + escapeHtml(person.name.trim().charAt(0).toUpperCase() || '?') + '</span>' +
        '<span class="person-item-text">' +
        '<span class="person-item-name">' + escapeHtml(person.name) + '</span>' +
        (person.role ? '<span class="person-item-role">' + escapeHtml(person.role) + '</span>' : '') +
        '</span>' +
        (person.id === active ? '<span class="person-check">✓</span>' : '') +
        '</button>';
    }).join('');
  }

  /* ---------------------------------------------------------- day details */

  function renderDayDetails(dateKey, now) {
    var day = Store.getDay(dateKey);
    var date = TL.dateFromKey(dateKey);
    el.logModalTitle.textContent = date.toLocaleDateString([], {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    if (!day || !day.events.length) {
      el.logDetailsBody.innerHTML =
        '<p class="empty-note">No record for this day.</p>' +
        '<button type="button" class="btn btn-secondary full" data-edit-day="' + escapeHtml(dateKey) + '">Add a record</button>';
      return;
    }

    var summary = TL.summarize(day, clampToDay(day, now));
    var target = targetMs();
    var balance = summary.creditedMs - target;

    var rows = [
      ['Counted towards the day', hm(summary.creditedMs), 'accent'],
      ['Against ' + compactHours(target), signedBalance(balance), balance >= 0 ? 'positive' : 'negative'],
      ['Desk work', hm(summary.workMs), ''],
      ['Meetings', shortDuration(summary.meetingMs), ''],
      ['Clocked in', clockTime(summary.firstIn), ''],
      ['Clocked out', summary.lastOut ? clockTime(summary.lastOut) : 'still open', ''],
      ['Short breaks', shortDuration(summary.breakMs), ''],
      ['Lunch', shortDuration(summary.lunchMs), ''],
      ['Paused', shortDuration(summary.pausedMs), '']
    ];

    var timeline = TL.segmentsOf(day, clampToDay(day, now)).map(function (seg) {
      return '<li class="timeline-row seg-' + seg.state.toLowerCase() + '">' +
        '<span class="timeline-time">' + clockTime(seg.from) + ' - ' + clockTime(seg.to) + '</span>' +
        '<span class="timeline-state">' + STATE_LABEL[seg.state] + '</span>' +
        '<span class="timeline-dur">' + shortDuration(seg.ms) + '</span>' +
        '</li>';
    }).join('');

    el.logDetailsBody.innerHTML =
      rows.map(function (row) {
        return '<div class="detail-row">' +
          '<span class="detail-label">' + escapeHtml(row[0]) + '</span>' +
          '<span class="detail-val ' + row[2] + '">' + escapeHtml(row[1]) + '</span>' +
          '</div>';
      }).join('') +
      (day.imported ? '<p class="empty-note">Imported from an older version - exact times were estimated.</p>' : '') +
      (day.note ? '<p class="day-note">' + escapeHtml(day.note) + '</p>' : '') +
      '<h4 class="timeline-heading">Timeline</h4>' +
      '<ul class="timeline-list">' + timeline + '</ul>' +
      '<button type="button" class="btn btn-secondary full" data-edit-day="' + escapeHtml(dateKey) + '">Correct this day</button>';
  }

  function clockFieldValue(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /** An HH:MM field read against the day being corrected, or null if empty. */
  function clockFieldMs(input, dateKey) {
    var parts = String(input.value || '').split(':');
    if (parts.length < 2) return null;
    var d = TL.dateFromKey(dateKey);
    d.setHours(Number(parts[0]) || 0, Number(parts[1]) || 0, 0, 0);
    return d.getTime();
  }

  function editFieldMinutes(input) {
    return Math.max(0, Number(input.value) || 0) * 60000;
  }

  /** Everything in the correction form that is not desk work. */
  function editRestMs() {
    return editFieldMinutes(el.editMeetingM) +
      editFieldMinutes(el.editBreakM) +
      editFieldMinutes(el.editLunchM) +
      editFieldMinutes(el.editPausedM);
  }

  /** True while the form is describing a day that has not finished yet. */
  function editIsOpen() {
    return !!(el.editStillRunning && el.editStillRunning.checked);
  }

  function setEditWork(workMs) {
    el.editWorkH.value = Math.floor(workMs / 3600000);
    el.editWorkM.value = Math.round((workMs % 3600000) / 60000);
  }

  function editWorkMs() {
    return (Math.max(0, Number(el.editWorkH.value) || 0) * 3600000) +
      (Math.max(0, Number(el.editWorkM.value) || 0) * 60000);
  }

  /**
   * Keep the correction form's own numbers agreeing.
   *
   * Desk work is the remainder of a shift, not arithmetic the user should be
   * doing on paper: correcting the start time to an hour earlier means an hour
   * more at the desk, and it now says so. Every uncounted minute - break, lunch
   * and pause alike - comes off it, which is the whole point of being able to
   * zero a pause that was tapped by accident.
   *
   * Two shapes, because a day that has not finished is a different problem:
   *
   *   Closed day    start and finish are both the user's. Typing a desk figure
   *                 moves the finish instead, so the two directions never fight
   *                 over the same value.
   *   Still running the finish IS now - there is nothing to type and nothing to
   *                 move - so desk work is read-only and follows the start and
   *                 the uncounted minutes.
   *
   * `source` is the field that changed - 'work' for the desk figure, anything
   * else for the clocks and the minute fields.
   */
  function syncEditForm(source) {
    var dateKey = el.editDayForm.dataset.dateKey;
    if (!dateKey) return '';

    var startMs = clockFieldMs(el.editStartTime, dateKey);
    if (startMs == null) return '';

    var restMs = editRestMs();
    var midnight = TL.nextMidnightOf(dateKey);
    var open = editIsOpen();
    var problem = '';

    // The finish is not the user's to set on an open day, and a field that
    // still looked editable would invite an edit that is silently overwritten.
    el.editEndTime.disabled = open;
    el.editWorkH.readOnly = open;
    el.editWorkM.readOnly = open;

    // Handing the field back has to re-stamp it. It has been showing whatever
    // "now" was when the sheet opened, which is a plausible-looking time that
    // nothing draws the eye to - unticking a minute later and saving would
    // quietly bin that minute.
    if (source === 'toggle' && !open) {
      el.editEndTime.value = clockFieldValue(Math.min(Date.now(), midnight - 60000));
      source = 'clock';
    }

    if (open) {
      var nowMs = Math.min(Date.now(), midnight - 60000);
      el.editEndTime.value = clockFieldValue(nowMs);

      var openWorkMs = nowMs - startMs - restMs;
      if (openWorkMs < 0) {
        problem = nowMs <= startMs
          ? 'That start time has not happened yet.'
          : 'The uncounted minutes add up to more than the time since you started.';
        openWorkMs = 0;
      }
      setEditWork(openWorkMs);
    } else if (source === 'work') {
      var endMs = startMs + editWorkMs() + restMs;
      // A shift the user has just made longer than the day it belongs to. The
      // clock is pinned to 23:59 rather than wrapping to the small hours,
      // where it would read as finishing before it started.
      if (endMs >= midnight) {
        endMs = midnight - 60000;
        problem = 'That runs past midnight, so the finish was pinned to 23:59.';
      }
      el.editEndTime.value = clockFieldValue(endMs);
    } else {
      var finishMs = clockFieldMs(el.editEndTime, dateKey);
      if (finishMs == null) {
        renderEditSpan('Set the time you finished, or tick "Still on the clock".');
        return 'Set the time you finished, or tick "Still on the clock".';
      }

      var workMs = finishMs - startMs - restMs;
      if (workMs < 0) {
        problem = finishMs <= startMs
          ? 'The finish time is before the start time.'
          : 'The meetings, breaks and pauses add up to more than the shift itself.';
        workMs = 0;
      }
      setEditWork(workMs);
    }

    renderEditSpan(problem);
    return problem;
  }

  /** The one-line readout under desk work: what the form currently describes. */
  function renderEditSpan(problem) {
    if (!el.editSpanHint) return;

    if (problem) {
      el.editSpanHint.textContent = problem;
      el.editSpanHint.hidden = false;
      return;
    }

    var dateKey = el.editDayForm.dataset.dateKey;
    var startMs = clockFieldMs(el.editStartTime, dateKey);
    var finishMs = clockFieldMs(el.editEndTime, dateKey);
    if (startMs == null || finishMs == null) {
      el.editSpanHint.hidden = true;
      return;
    }

    el.editSpanHint.textContent = shortDuration(Math.max(0, finishMs - startMs)) +
      (editIsOpen() ? ' so far, ' : ' on site, ') +
      shortDuration(editWorkMs() + editFieldMinutes(el.editMeetingM)) + ' counted.' +
      (editAfterHours
        ? ' This day was ended and reopened later, and saving merges it into one shift.'
        : '');
    el.editSpanHint.hidden = false;
  }

  /* Set when the day being corrected was ended and then reopened - the evening
     meeting. The form models a day as one continuous shift, so saving flattens
     that gap and credits the off-the-clock hours; say so rather than let the
     number arrive as a surprise. */
  var editAfterHours = false;

  /** Load a day into the manual-correction form. */
  function fillEditForm(dateKey, now) {
    var day = Store.getDay(dateKey);
    var date = TL.dateFromKey(dateKey);
    el.editDayTitle.textContent = 'Correct ' + date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    el.editDayForm.dataset.dateKey = dateKey;

    // Clamped like the banner: an unclamped stale day prefilled "74" hours,
    // which fails the field's max="24" and left Save doing nothing - dead-ending
    // the exact flow the recovery banner exists to make easy.
    var summary = day ? TL.summarize(day, clampToDay(day, now)) : null;
    var startMs = (summary && summary.firstIn) || (date.getTime() + 9 * 3600000);

    // A day still on the clock opens in its own shape, so correcting today does
    // not demand a finish time that has not happened.
    //
    // Only today can be still running, and the offer is withdrawn rather than
    // left to mean something odd: ticked on last Tuesday it read "running until
    // 23:59 that night", which is both untrue and the exact 30-hour day the 10pm
    // auto-close exists to prevent.
    editAfterHours = !!(day && day.events.some(function (ev, i) {
      return ev.s === TL.STATES.ENDED && i < day.events.length - 1;
    }));

    var isToday = dateKey === TL.dateKeyOf(now);
    if (el.editStillRunningRow) el.editStillRunningRow.hidden = !isToday;
    if (el.editStillRunning) el.editStillRunning.checked = isToday && !!(day && TL.isRunning(day));

    el.editStartTime.value = clockFieldValue(startMs);
    el.editWorkH.value = summary ? Math.floor(summary.workMs / 3600000) : 8;
    el.editWorkM.value = summary ? Math.floor((summary.workMs % 3600000) / 60000) : 0;
    el.editMeetingM.value = summary ? Math.round(summary.meetingMs / 60000) : 0;
    el.editBreakM.value = summary ? Math.round(summary.breakMs / 60000) : 0;
    el.editLunchM.value = summary ? Math.round(summary.lunchMs / 60000) : 0;
    el.editPausedM.value = summary ? Math.round(summary.pausedMs / 60000) : 0;
    el.editNote.value = (day && day.note) || '';
    el.deleteDayBtn.hidden = !day;

    // Derived from the fields as they now read, not from the raw summary: the
    // minute values above are rounded, and a finish time carrying the leftover
    // seconds would disagree with the very numbers beside it.
    return syncEditForm('work');
  }

  /* ------------------------------------------------------------- settings */

  /**
   * Where the user has to go to unblock notifications.
   *
   * Worth stating plainly, because it constrains everything below: no web API
   * can open the browser's or the operating system's notification settings. A
   * page cannot navigate to `chrome://settings/...` either — Chrome blocks
   * that as a navigation target from web content. So the best a web app can
   * honestly do is name the exact path on the platform the user is standing
   * on, and then notice the moment they come back having changed it, which is
   * what the permission watcher in app.js does.
   *
   * The path genuinely differs between an installed PWA and a browser tab: an
   * installed app gets its own entry in Android's app settings, while a tab's
   * permission lives under the browser's per-site settings.
   */
  function unblockSteps() {
    var ua = navigator.userAgent || '';
    var installed = global.matchMedia && global.matchMedia('(display-mode: standalone)').matches;
    var iOS = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var android = /Android/.test(ua);

    if (iOS) {
      return installed
        ? ['Open the iPhone <strong>Settings</strong> app.',
           'Tap <strong>Notifications</strong>.',
           'Find <strong>Track8</strong> in the list and turn <strong>Allow Notifications</strong> on.']
        : ['Notifications only work once Track8 is on your Home Screen.',
           'Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.',
           'Open it from the Home Screen icon and allow notifications when asked.'];
    }

    if (android) {
      return installed
        ? ['Press and hold the <strong>Track8</strong> icon on your home screen.',
           'Tap <strong>App info</strong> (the ⓘ button).',
           'Tap <strong>Notifications</strong> and turn them on.']
        : ['Tap the <strong>lock or tune icon</strong> to the left of the web address.',
           'Tap <strong>Permissions</strong>, then <strong>Notifications</strong>.',
           'Set it to <strong>Allow</strong>, then come back here.'];
    }

    return ['Click the <strong>lock or tune icon</strong> to the left of the web address.',
            'Find <strong>Notifications</strong> and set it to <strong>Allow</strong>.',
            'Reload this page.'];
  }

  /**
   * The permission state gets a card rather than a sentence, because it is the
   * one setting in the app that can be switched off from outside the app and
   * leave every reminder silently dead.
   */
  function renderNotifyCard(notify) {
    if (!el.permCard) return;

    var perm = notify.permission();
    var blocked = perm === 'denied';

    el.permCard.className = 'perm-card' +
      (perm === 'granted' ? ' granted' : '') +
      (blocked ? ' denied' : '');

    el.permTitle.textContent = {
      granted: 'Reminders are on',
      denied: 'Reminders are blocked',
      unsupported: 'Reminders are unavailable'
    }[perm] || 'Reminders are off';

    el.notifyStatusText.textContent = {
      granted: notify.hasServiceWorker()
        ? 'A pinned notification stays in your shade for the whole break, and you are nudged if it runs long.'
        : 'On, but limited — open Track8 from a web address rather than a file for background reminders.',
      denied: 'This site was blocked from sending notifications, so you will only be reminded while the app is open on screen. Your browser will not let a web page undo that, so it has to be switched back on from the settings below.',
      unsupported: 'This browser cannot show notifications at all. Track8 will still remind you in the app.'
    }[perm] || 'Break and lunch reminders are switched off. Turn them on to be nudged when a break runs long.';

    if (blocked) {
      el.permSteps.innerHTML = unblockSteps().map(function (step) {
        return '<li>' + step + '</li>';
      }).join('');
      el.permSteps.hidden = false;
      el.permSiteUrl.textContent = global.location.origin + global.location.pathname;
      el.permSite.hidden = false;
    } else {
      el.permSteps.hidden = true;
      el.permSite.hidden = true;
    }

    // The old form left "Turn on notifications" visible while blocked, where
    // tapping it did nothing at all: requestPermission() returns 'denied'
    // without prompting once the user has refused. Blocked state gets "Check
    // again" instead, which re-reads the permission after they have been to
    // settings.
    el.enableNotifyBtn.hidden = perm === 'granted' || perm === 'unsupported' || blocked;
    el.recheckNotifyBtn.hidden = !blocked;
    el.testNotifyBtn.hidden = perm !== 'granted';
  }

  /**
   * Explain a background reminder that never arrived, and what to change.
   *
   * Shown only after the phone has actually been caught suspending the
   * keep-alive, so it reads as the explanation for something the user just
   * experienced rather than a permanent warning about something that might.
   * Every step here is a phone setting; none of it can be done from a web page.
   */
  /**
   * Say which layer is actually protecting this phone.
   *
   * When the server holds the reminder, the on-device workarounds below it
   * stop mattering and the battery warning would be noise — so it is
   * suppressed. When the server is not there, this line is what tells the user
   * they are relying on the phone's goodwill.
   */
  function renderPushStatus() {
    if (!el.pushStatus) return;
    var push = global.T8Push ? global.T8Push.status() : { supported: false, active: false };

    if (push.active) {
      el.pushStatus.textContent = 'Reminders are sent from the server, so they arrive even if your phone stops the app. Nothing below is needed.';
    } else if (!push.supported) {
      el.pushStatus.textContent = 'This browser cannot receive reminders from the server, so they run on the phone.';
    } else {
      el.pushStatus.textContent = 'Reminders are running on this phone only. They can be stopped by your battery settings.';
    }
    return push;
  }

  function renderKeepAliveStatus(notify) {
    if (!el.keepAliveWarning) return;

    var push = renderPushStatus();
    var interrupted = notify.keepAliveWasInterrupted && notify.keepAliveWasInterrupted();
    el.keepAliveWarning.hidden = !interrupted || !Store.settings().keepAliveEnabled ||
      (push && push.active);

    if (interrupted && el.batterySteps) {
      var ua = navigator.userAgent || '';
      var steps = /Android/.test(ua)
        ? ['Open <strong>Settings</strong> → <strong>Apps</strong> → <strong>Track8</strong> (or Chrome, if you have not installed Track8).',
           'Tap <strong>Battery</strong> and choose <strong>Unrestricted</strong>.',
           'On Xiaomi, Oppo, Vivo, Realme or OnePlus, also turn on <strong>Autostart</strong> and set battery saver to <strong>No restrictions</strong>.']
        : ['iPhones suspend background pages regardless of settings.',
           'The pinned notification and the catch-up reminder when you reopen the app still work.'];

      el.batterySteps.innerHTML = steps.map(function (s) { return '<li>' + s + '</li>'; }).join('');
    }

    if (el.vibrateNote) {
      el.vibrateNote.textContent = notify.vibrationSupported()
        ? 'Phones can override this from the notification settings for this app.'
        : 'This device has no vibration API, so reminders can only make a sound.';
    }
  }

  function fillSettingsForm(notify) {
    var s = Store.settings();
    var person = Store.activePerson();

    el.setDailyTarget.value = (s.dailyTargetMinutes / 60).toFixed(2).replace(/\.?0+$/, '');
    el.setBreakAlert.value = s.breakAlertMinutes;
    el.setBreakRepeat.value = s.breakRepeatMinutes;
    el.setLunchAlert.value = s.lunchAlertMinutes;
    el.setLunchRepeat.value = s.lunchRepeatMinutes;
    el.setKeepAlive.checked = !!s.keepAliveEnabled;
    el.setVibrate.checked = !!s.vibrate;

    el.setStretchAlert.value = s.stretchAlertMinutes;
    el.setStretchRepeat.value = s.stretchRepeatMinutes;
    el.setPauseAlert.value = s.pauseAlertMinutes;
    el.setMeetingAlert.value = s.meetingAlertMinutes;
    el.setOvertimeReminder.checked = !!s.overtimeReminder;

    el.renamePersonInput.value = person.name;
    el.renamePersonRole.value = person.role || '';
    el.deletePersonBtn.disabled = Store.persons().length <= 1;

    renderNotifyCard(notify);
    renderKeepAliveStatus(notify);
    renderSettingsSummaries(notify);
  }

  /**
   * Apply the chosen theme.
   *
   * The attribute goes on <html>, not <body>, so the very first paint is right:
   * the stylesheet's light block keys off `:root[data-theme]`, and a class added
   * to body after load would flash the dark palette first. `system` leaves the
   * attribute set to "system" rather than removed, so the media query has a
   * selector to match and an explicit dark choice can still win over a light OS.
   *
   * theme-color follows, or the phone's status bar stays black over a white app.
   */
  var THEME_LABELS = { system: 'matching your phone', light: 'light', dark: 'dark' };

  function systemPrefersLight() {
    return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches);
  }

  /**
   * What the header button will switch to next: light or dark, nothing else.
   *
   * "Match phone" is still a choice in Appearance, but it is not a stop on the
   * header button's route. That button is a one-tap glance control and a
   * three-way cycle through it means the tap meant to darken the screen lands on
   * the OS setting instead, which on a phone already set to dark looks like the
   * button did nothing at all.
   *
   * From `system` it flips away from whatever the phone is currently showing, so
   * the first tap always changes something visible.
   */
  function nextTheme() {
    var theme = Store.settings().theme || 'system';
    if (theme === 'dark') return 'light';
    if (theme === 'light') return 'dark';
    return systemPrefersLight() ? 'dark' : 'light';
  }

  function applyTheme() {
    var theme = Store.settings().theme || 'system';
    document.documentElement.setAttribute('data-theme', theme);

    // Which icon is showing is CSS's business; the label is not, and a button
    // whose icon changes has to say what it does or a screen reader user gets
    // "Theme" three times with no way to tell them apart.
    if (el.themeBtn) {
      var label = 'Theme: ' + THEME_LABELS[theme] + '. Switch to ' + THEME_LABELS[nextTheme()];
      el.themeBtn.setAttribute('aria-label', label);
      el.themeBtn.title = label;
    }

    var light = theme === 'light' || (theme === 'system' && systemPrefersLight());

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#f2f5f3' : '#0b100e');

    document.querySelectorAll('[data-theme-choice]').forEach(function (btn) {
      var active = btn.getAttribute('data-theme-choice') === theme;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  /** Seed the first-run form from the defaults the store already holds. */
  function fillSetupForm() {
    var s = Store.settings();
    if (!el.setupTarget) return;
    el.setupTarget.value = (s.dailyTargetMinutes / 60).toFixed(2).replace(/\.?0+$/, '');
    el.setupBreak.value = s.breakAlertMinutes;
    el.setupLunch.value = s.lunchAlertMinutes;
  }

  /** Collapsed groups still have to answer "what is this set to?". */
  function renderSettingsSummaries(notify) {
    var s = Store.settings();
    var person = Store.activePerson();
    var perm = notify.permission();

    if (el.sumReminders) {
      el.sumReminders.textContent = perm === 'granted'
        ? 'On' + (s.vibrate ? ' · vibrate' : '') + (s.keepAliveEnabled ? ' · screen off' : '')
        : (perm === 'denied' ? 'Blocked — needs your attention' : 'Off · tap to turn on');
    }
    if (el.sumTimers) {
      // The three people actually change, in the order they think about them.
      // The rest of the group's numbers are visible the moment it opens, and a
      // header that listed all seven would be unreadable at 11px.
      el.sumTimers.textContent = compactHours(s.dailyTargetMinutes * 60000) + ' day · break ' +
        s.breakAlertMinutes + 'm · lunch ' + s.lunchAlertMinutes + 'm';
    }
    if (el.sumAppearance) {
      var theme = s.theme || 'system';
      el.sumAppearance.textContent =
        theme === 'system' ? 'Matching your phone' : (theme === 'light' ? 'Light' : 'Dark');
    }
    if (el.sumProfile) {
      el.sumProfile.textContent = person.name + (person.role ? ' · ' + person.role : '') +
        ' · ' + Store.persons().length + (Store.persons().length === 1 ? ' profile' : ' profiles');
    }
    if (el.sumInstall) {
      var installed = global.matchMedia && global.matchMedia('(display-mode: standalone)').matches;
      el.sumInstall.textContent = installed ? 'Installed' : 'Not on your home screen yet';
    }

    renderSyncStatus();
  }

  /**
   * Whether this device's hours are actually being saved anywhere but here.
   *
   * Worth stating plainly rather than assuming: "signed in" and "syncing" are
   * not the same thing, and a phone that has been offline for a week is in the
   * second state without knowing it.
   */
  function renderSyncStatus() {
    if (!global.T8Sync) return;
    var s = global.T8Sync.status();

    if (el.sumAccount) {
      el.sumAccount.textContent = !s.available ? 'Not available on this server'
        : s.signedIn ? s.email
          : 'Not signed in';
    }

    // "Nothing is uploaded anywhere" was a fixed sentence written before this
    // app had accounts, and it stayed on screen while the same screen offered
    // to sync. Where the hours actually live is the one thing this group has to
    // be right about, so both lines are written from the account state.
    if (el.sumData) {
      el.sumData.textContent = s.signedIn ? 'Synced to your account' : 'On this device only';
    }
    if (el.dataScopeNote) {
      el.dataScopeNote.textContent = s.signedIn
        ? 'Your days sync to ' + s.email + ', so a new phone can pick them up by signing in. This device stays the working copy and never waits on the network. The backup file is still the only thing that can be restored into a device with no account.'
        : 'Everything is stored on this device only. Nothing is uploaded anywhere. Clearing your browser data deletes it, so take a backup now and then.';
    }

    if (el.syncStatusText) {
      var message;
      if (!s.available) {
        message = 'This copy of Track8 has no sync server, so your hours live on this device only. Take a backup now and then.';
      } else if (!s.signedIn) {
        message = 'Not signed in. Your hours are on this device only.';
      } else if (!s.online) {
        message = 'Signed in as ' + s.email + '. Offline right now - everything is saved here and will sync when you are back.';
      } else if (s.lastSyncOk === false) {
        message = 'Signed in as ' + s.email + ', but the last sync failed (' + s.error + '). It will retry on its own.';
      } else if (s.lastSyncAt) {
        message = 'Signed in as ' + s.email + '. Last synced ' + clockTime(s.lastSyncAt) + '.';
      } else {
        message = 'Signed in as ' + s.email + '. First sync has not run yet.';
      }
      el.syncStatusText.textContent = message;
    }

    if (el.signOutBtn) el.signOutBtn.hidden = !s.signedIn;
    if (el.syncNowBtn) el.syncNowBtn.hidden = !s.signedIn;
    if (el.changeEmailBtn) el.changeEmailBtn.hidden = !s.signedIn;
    // Closing the panel whenever the account state changes stops a half-filled
    // email change surviving a sign-out.
    if (el.emailChangePanel && !s.signedIn) el.emailChangePanel.hidden = true;
  }

  /* ---------------------------------------------------------------- views */

  function showView(name) {
    ['timer', 'week', 'calendar'].forEach(function (view) {
      var node = el['view' + view.charAt(0).toUpperCase() + view.slice(1)];
      if (!node) return;
      var isTarget = view === name;
      node.hidden = !isTarget;

      // Restart the entry animation each time. Removing the class and reading
      // offsetWidth is the standard way to replay a CSS animation on a node
      // that already carries it.
      node.classList.remove('entering');
      if (isTarget) {
        void node.offsetWidth;
        node.classList.add('entering');
      }
    });
    document.querySelectorAll('.bottom-nav .nav-item[data-view]').forEach(function (btn) {
      var active = btn.getAttribute('data-view') === name;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    });
    window.scrollTo({ top: 0 });
  }

  /* ---------------------------------------------------------------- modals */

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // Where focus was before the dialog opened, so it can be handed back.
  var focusReturn = null;
  var trapHandler = null;

  function visibleFocusable(node) {
    return Array.prototype.filter.call(node.querySelectorAll(FOCUSABLE), function (n) {
      return !n.hidden && n.offsetParent !== null;
    });
  }

  /**
   * `aria-modal="true"` is a promise to assistive tech that the rest of the
   * page is unreachable. Nothing was enforcing it: Tab walked straight out of
   * the dialog into the timer behind it, and closing left focus on <body>. The
   * cycle is implemented here rather than with the `inert` attribute because
   * inert is still missing on the older Android WebViews this app targets.
   */
  function openModal(node) {
    focusReturn = document.activeElement;
    node.hidden = false;
    node.classList.add('open');
    document.body.classList.add('modal-open');

    var focusable = node.querySelector('input, select, button:not(.close-btn)');
    if (focusable) setTimeout(function () { focusable.focus(); }, 60);

    trapHandler = function (event) {
      if (event.key !== 'Tab') return;
      var items = visibleFocusable(node);
      if (!items.length) return;

      var first = items[0];
      var last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!node.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', trapHandler);
    document.addEventListener('keydown', trapHandler);
  }

  function closeModal(node) {
    node.classList.remove('open');
    node.hidden = true;

    if (trapHandler) {
      node.removeEventListener('keydown', trapHandler);
      document.removeEventListener('keydown', trapHandler);
      trapHandler = null;
    }

    // Only release the page scroll once no dialog is left open — the day
    // details sheet can open the correction sheet on top of itself.
    if (!document.querySelector('.modal-overlay.open')) {
      document.body.classList.remove('modal-open');
    }

    if (focusReturn && focusReturn.focus) {
      try { focusReturn.focus(); } catch (e) { /* node may be gone */ }
    }
    focusReturn = null;
  }

  /**
   * Mark the app as being in Tanglish mode.
   *
   * The logo is the only thing that changes, and it changes because it is the
   * thing that was tapped: an easter egg that leaves no trace reads as a bug
   * the next morning, when the reminders have started speaking Tamil and
   * nothing on screen says why.
   */
  function renderTanglishState() {
    if (!el.appRoot) return;
    var on = Store.settings().tanglishReminders === true;
    el.appRoot.classList.toggle('tanglish', on);
    if (el.brandTargetBadge) el.brandTargetBadge.classList.toggle('tanglish', on);
  }

  /* ------------------------------------------------------------ walkthrough */

  /**
   * The first-run tour.
   *
   * Every step points at a control that is already on screen — no screenshots,
   * no mock-ups — so it cannot drift out of date with the layout and it lands
   * in the right place on any screen size. Steps whose target is not currently
   * visible (a row dropped by one of the height queries) are removed before the
   * tour starts rather than skipped mid-way, so "3 of 6" stays honest.
   *
   * The copy is one short sentence per step for two reasons: nobody reads a
   * paragraph to get past a walkthrough, and the card is parked in one place
   * for the whole tour, so it has to clear the controls it points at.
   */
  var TOUR_STEPS = [
    {
      sel: '#btnStart',
      title: 'Start the day here',
      text: 'One tap when you sit down. It keeps counting with the app closed and the phone asleep.'
    },
    {
      sel: '#progressRingContainer',
      title: 'The dial is your day',
      text: 'The ring is your 8-hour goal; the digits count whatever is running right now.'
    },
    {
      sel: '.action-buttons-grid',
      title: 'Log what you are doing',
      text: 'Break, lunch, meeting, pause, End day. Breaks and lunch do not count; meetings do.'
    },
    {
      sel: '.session-stats-bar',
      title: 'Today at a glance',
      text: 'Meetings, breaks, lunch and paused time, updated as you go.'
    },
    {
      sel: '.bottom-nav [data-view="week"]',
      title: 'Your week',
      text: 'Your hours a day against the goal, and how far ahead or behind you are.'
    },
    {
      sel: '.bottom-nav [data-view="calendar"]',
      title: 'The month',
      text: 'Every day with its hours. Tap one to fix a day you forgot to close.'
    },
    {
      sel: '#openSettingsBtn',
      title: 'Reminders and the rest',
      text: 'Nudges that reach you with the screen off, your target, export and backup.'
    }
  ];

  var tourSteps = [];
  var tourIndex = 0;
  var tourBound = false;
  var tourKeyHandler = null;

  /** The target's box, or null when it is missing or currently collapsed. */
  function tourRect(step) {
    var node = document.querySelector(step.sel);
    if (!node) return null;
    var rect = node.getBoundingClientRect();
    return (rect.width > 0 && rect.height > 0) ? rect : null;
  }

  function renderTourStep() {
    var step = tourSteps[tourIndex];
    var rect = step && tourRect(step);

    // The layout changed under us — a rotation, or the keyboard opening. There
    // is nothing sensible to point at, so leave rather than highlight air.
    if (!rect) { endTour(); return; }

    el.tourSpotlight.style.width = (rect.width + TOUR_PAD * 2) + 'px';
    el.tourSpotlight.style.height = (rect.height + TOUR_PAD * 2) + 'px';
    el.tourSpotlight.style.transform =
      'translate(' + (rect.left - TOUR_PAD) + 'px, ' + (rect.top - TOUR_PAD) + 'px)';

    el.tourCount.textContent = 'Step ' + (tourIndex + 1) + ' of ' + tourSteps.length;
    el.tourTitle.textContent = step.title;
    el.tourText.textContent = step.text;
    el.tourNextBtn.textContent = tourIndex === tourSteps.length - 1 ? 'Got it' : 'Next';
  }

  var TOUR_MARGIN = 12;
  // How far the highlight ring stands off its target. Placement has to clear
  // the ring, not the control, or the card lands on the glow.
  var TOUR_PAD = 6;

  /**
   * Park the card once, for the whole tour.
   *
   * It used to hunt for a gap beside each highlight, which meant it hopped
   * across the screen on every Next and the reader had to find it again before
   * they could read it. It now takes one seat and only the spotlight moves.
   *
   * The seat is measured rather than hard-coded, because there is no constant
   * that is right twice: it is the widest horizontal band that none of the
   * steps' targets sit in. On a phone that lands between the buttons and the
   * nav and the tour never covers anything. A landscape phone is 360px tall
   * with no band that big, so the fallback takes whichever of the two edges
   * hides the fewest controls - still one seat for the whole tour.
   */
  /**
   * Freeze the card at the height of its longest step.
   *
   * A fixed seat is only half of standing still: a two-line step after a
   * three-line one shrinks the box out from under the buttons, which is the
   * same jumping on one edge. Costs one layout pass per step, once per tour,
   * and cannot be done in CSS because the line count depends on the width.
   */
  function sizeTourCard() {
    var tallest = 0;
    el.tourCard.style.height = '';
    tourSteps.forEach(function (step) {
      el.tourText.textContent = step.text;
      el.tourTitle.textContent = step.title;
      tallest = Math.max(tallest, el.tourCard.offsetHeight);
    });
    el.tourCard.style.height = tallest + 'px';
  }

  function placeTourCard() {
    var card = el.tourCard;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var h = card.offsetHeight;

    // The nav is fixed over the content, so the usable bottom edge is its top.
    var nav = document.querySelector('.bottom-nav');
    var floor = nav ? Math.min(vh, nav.getBoundingClientRect().top) : vh;

    // Merged into occupied bands first. Targets nest and share edges - the
    // Start button *is* one of the buttons in the grid, and the three nav items
    // sit side by side - and counting the same strip of screen twice would let
    // a seat that hides one row score worse than one that hides the dial.
    var rects = [];
    tourSteps.map(tourRect).filter(Boolean)
      .map(function (r) { return { top: r.top - TOUR_PAD, bottom: r.bottom + TOUR_PAD }; })
      .sort(function (a, b) { return a.top - b.top; })
      .forEach(function (r) {
        var last = rects[rects.length - 1];
        if (last && r.top <= last.bottom) last.bottom = Math.max(last.bottom, r.bottom);
        else rects.push(r);
      });

    // Centred in every band no target sits in, plus the two edges as a last
    // resort for a screen with no band big enough.
    var seats = [TOUR_MARGIN, floor - h - TOUR_MARGIN];
    var cursor = TOUR_MARGIN;
    rects.concat([{ top: vh - TOUR_MARGIN, bottom: vh }]).forEach(function (r) {
      seats.push(cursor + (r.top - TOUR_MARGIN - cursor - h) / 2);
      cursor = r.bottom + TOUR_MARGIN;
    });

    // Scored by how much of a target each seat would hide, not by how many it
    // touches: a band slightly too short still beats an edge that buries the
    // dial, and a seat that hides nothing scores zero and wins outright.
    var clamp = function (t) { return Math.max(TOUR_MARGIN, Math.min(t, vh - h - TOUR_MARGIN)); };
    var hidden = function (t) {
      return rects.reduce(function (sum, r) {
        return sum + Math.max(0, Math.min(r.bottom, t + h) - Math.max(r.top, t));
      }, 0);
    };

    var top = seats.map(clamp).reduce(function (bestSeat, seat) {
      return hidden(seat) < hidden(bestSeat) ? seat : bestSeat;
    });

    card.style.top = Math.round(top) + 'px';
    card.style.left = Math.round((vw - card.offsetWidth) / 2) + 'px';
  }

  function nextTourStep() {
    if (tourIndex >= tourSteps.length - 1) { endTour(); return; }
    tourIndex++;
    renderTourStep();
  }

  function endTour() {
    if (el.tourOverlay.hidden) return;
    Store.markSeen('tour');
    closeModal(el.tourOverlay);
    global.removeEventListener('resize', onTourResize);
    document.removeEventListener('keydown', tourKeyHandler);
  }

  /** A rotation moves every target and rewraps the copy, so both are redone. */
  function onTourResize() {
    sizeTourCard();
    renderTourStep();
    placeTourCard();
  }

  function startTour() {
    if (!el.tourOverlay || !el.tourOverlay.hidden) return;

    tourSteps = TOUR_STEPS.filter(tourRect);
    if (!tourSteps.length) return;
    tourIndex = 0;

    // Steps 1 to 4 live on the timer view, and the nav steps read as nonsense
    // from anywhere else.
    showView('timer');

    if (!tourBound) {
      el.tourNextBtn.addEventListener('click', nextTourStep);
      el.tourSkipBtn.addEventListener('click', endTour);
      tourBound = true;
    }

    tourKeyHandler = function (event) {
      if (event.key === 'Escape') endTour();
    };
    document.addEventListener('keydown', tourKeyHandler);
    global.addEventListener('resize', onTourResize);

    openModal(el.tourOverlay);
    // Sized before it is seated, and seated before either is shown to anyone.
    sizeTourCard();
    renderTourStep();
    placeTourCard();
  }

  /** First run only, and never on top of the sign-in gate or an open dialog. */
  function maybeStartTour() {
    if (Store.seen('tour')) return;
    if (el.signinScreen && !el.signinScreen.hidden) return;
    if (document.querySelector('.modal-overlay.open')) return;
    startTour();
  }

  function renderDateHeader(now) {
    var d = new Date(now);
    el.currentDayName.textContent = d.toLocaleDateString([], { weekday: 'long' });
    el.currentFullDate.textContent = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    if (el.brandTargetBadge) el.brandTargetBadge.textContent = compactHours(targetMs()) + ' goal';
  }

  global.T8UI = {
    el: el,
    cache: cache,
    escapeHtml: escapeHtml,
    hms: hms,
    hm: hm,
    shortDuration: shortDuration,
    clockTime: clockTime,
    signedBalance: signedBalance,
    targetMs: targetMs,
    startOfWeek: startOfWeek,
    toast: toast,
    renderTimer: renderTimer,
    renderActions: renderActions,
    renderReminderStatus: renderReminderStatus,
    renderOpenShiftBanner: renderOpenShiftBanner,
    renderWeek: renderWeek,
    renderCalendar: renderCalendar,
    renderPersonHeader: renderPersonHeader,
    renderPersonList: renderPersonList,
    renderDayDetails: renderDayDetails,
    renderDateHeader: renderDateHeader,
    fillEditForm: fillEditForm,
    syncEditForm: syncEditForm,
    editIsOpen: editIsOpen,
    fillSettingsForm: fillSettingsForm,
    renderNotifyCard: renderNotifyCard,
    renderKeepAliveStatus: renderKeepAliveStatus,
    renderPushStatus: renderPushStatus,
    renderSyncStatus: renderSyncStatus,
    renderSettingsSummaries: renderSettingsSummaries,
    showView: showView,
    openModal: openModal,
    closeModal: closeModal,
    startTour: startTour,
    maybeStartTour: maybeStartTour,
    toggleDialMode: toggleDialMode,
    renderTanglishState: renderTanglishState,
    fillSetupForm: fillSetupForm,
    applyTheme: applyTheme,
    nextTheme: nextTheme
  };
})(typeof window !== 'undefined' ? window : globalThis);
