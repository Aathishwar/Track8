/**
 * Track8 - Application wiring
 *
 * Holds the state machine, the tick loop and every event handler. Deliberately
 * thin: durations come from timeline.js, persistence from store.js, reminders
 * from notify.js, and all DOM writing from ui.js.
 */
(function (global) {
  'use strict';

  var TL = global.T8Timeline;
  var Store = global.T8Store;
  var Notify = global.T8Notify;
  var Push = global.T8Push;
  var Sync = global.T8Sync;
  var UI = global.T8UI;
  var Report = global.T8Report;
  var S = TL.STATES;

  var el;

  var TICK_MS = 1000;

  // A tick gap longer than this means the page was frozen or backgrounded
  // rather than merely slow. We then re-derive everything from timestamps
  // instead of trusting that we watched the intervening time pass.
  var SUSPEND_GAP_MS = 90 * 1000;

  var tickHandle = null;
  var lastTickAt = Date.now();

  var weekAnchor = new Date();
  var monthAnchor = new Date();
  var activeDayKey = TL.dateKeyOf(Date.now());
  var openShiftDismissed = false;
  var deferredInstallPrompt = null;

  /**
   * Bind a listener only if the element is there.
   *
   * For controls introduced by a release the loaded index.html may predate. A
   * rolling deploy can serve an old page against new scripts for a few
   * seconds, and `null.addEventListener` throws out of init, unbinding
   * everything after it - the timer keeps running while settings, sync and
   * export are silently dead until the next reload. Skipping one control is a
   * far better failure than losing half the app.
   */
  function bindIfPresent(node, type, handler) {
    if (node) node.addEventListener(type, handler);
  }

  /**
   * Midnight on the Monday of a date's week, as a timestamp.
   *
   * Only used to compare two weeks, which is why it collapses the whole week
   * to one number: two dates in the same week give the same result.
   */
  function startOfWeekMs(date) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - d.getDay()); // Sunday-first, like UI.startOfWeek
    return d.getTime();
  }

  /* ------------------------------------------------------------ day access */

  function today(now) {
    return TL.dateKeyOf(now == null ? Date.now() : now);
  }

  function currentDay() {
    return Store.getDay(activeDayKey) || TL.createDay(activeDayKey);
  }

  function currentState() {
    return TL.currentState(currentDay());
  }

  /**
   * Record a state transition and persist it.
   *
   * This is the only place a day's timeline grows, and the only place that
   * writes to storage during normal use - once per button press rather than
   * once per second.
   */
  function transition(nextState, when) {
    var day = Store.ensureDay(activeDayKey);
    var previous = TL.currentState(day);
    if (!TL.pushEvent(day, nextState, when)) return false;

    // Stamp before saving: an unstamped change is invisible to sync and would
    // never leave this device.
    Store.touchDay(day);
    Store.save();
    Sync.schedule('transition');

    var wasResting = previous === S.BREAK || previous === S.LUNCH;
    var isResting = nextState === S.BREAK || nextState === S.LUNCH;

    if (isResting) {
      Notify.onBreakStarted(nextState, TL.lastEvent(day).t);
      armServerReminder(nextState, TL.lastEvent(day).t);
    } else if (wasResting) {
      Notify.onBreakEnded();
      Push.disarm();
    }

    renderAll();
    return true;
  }

  /* ------------------------------------------------------ day reconciliation */

  /**
   * Keep `activeDayKey` pointing at the real current date, and decide what to
   * do about a shift that is still open from an earlier day.
   *
   * Two very different situations, handled differently on purpose:
   *
   *  - The app was open and running when the clock passed midnight. The user
   *    genuinely is still working, so the day is closed at midnight and a new
   *    day continues in the same state.
   *
   *  - The app was closed or frozen and we are only now finding out. We have no
   *    idea when the user actually stopped, so nothing is invented: the stale
   *    day is left alone and a banner asks the user to correct it.
   */
  function reconcile(now, wasSuspended) {
    var key = today(now);

    if (key !== activeDayKey) {
      var previous = Store.getDay(activeDayKey);

      if (previous && TL.isRunning(previous) && !wasSuspended) {
        var split = TL.splitAtMidnight(previous, now);
        while (split) {
          Store.putDay(split.closed);
          Store.putDay(split.carried);
          if (split.carried.dateKey === key) break;
          split = TL.splitAtMidnight(split.carried, now);
        }
        UI.toast('Past midnight - yesterday was closed out and today started.', 'info');
      }

      activeDayKey = key;
      monthAnchor = new Date(now);
      weekAnchor = new Date(now);
      openShiftDismissed = false;
    }

    return Store.findOpenDay(null, activeDayKey);
  }

  /* -------------------------------------------------------------- rendering */

  function renderAll() {
    var now = Date.now();
    UI.renderDateHeader(now);
    UI.renderPersonHeader();

    var summary = UI.renderTimer(currentDay(), now);
    UI.renderWeek(weekAnchor, now);
    UI.renderCalendar(monthAnchor, now);
    UI.renderReminderStatus(Notify);
    renderOpenShift();

    return summary;
  }

  function renderOpenShift() {
    if (openShiftDismissed) {
      el.openShiftBanner.hidden = true;
      return;
    }
    UI.renderOpenShiftBanner(Store.findOpenDay(null, activeDayKey));
  }

  /* ------------------------------------------------------------- tick loop */

  /**
   * One timer for the whole app.
   *
   * While hidden it skips rendering and only runs the reminder check, which is
   * the sole thing that must keep working with the screen off.
   */
  function tick() {
    var now = Date.now();
    var gap = now - lastTickAt;
    var wasSuspended = gap > SUSPEND_GAP_MS;
    lastTickAt = now;

    reconcile(now, wasSuspended);

    var day = currentDay();
    var summary = TL.summarize(day, now);

    Notify.check(summary);

    if (document.visibilityState === 'visible') {
      UI.renderTimer(day, now);
      if (wasSuspended) {
        UI.renderWeek(weekAnchor, now);
        UI.renderCalendar(monthAnchor, now);
        renderOpenShift();
      }
    }
  }

  function startTicking() {
    if (tickHandle) clearInterval(tickHandle);
    lastTickAt = Date.now();
    tickHandle = setInterval(tick, TICK_MS);
  }

  /**
   * Layer 3 of the reminder: whatever happened while we were away, the moment
   * the user looks at the app they get the truth immediately.
   */
  function onBecameVisible() {
    var now = Date.now();
    lastTickAt = now;
    reconcile(now, true);

    var summary = TL.summarize(currentDay(), now);
    var result = Notify.check(summary);

    renderAll();

    // Coming back from the phone's settings is the one moment the permission
    // is most likely to have changed under us. Browsers without
    // permissions.query never fire the watcher, so this is their update path.
    if (el.settingsModal && !el.settingsModal.hidden) UI.fillSettingsForm(Notify);

    if (result && result.index >= 0 && (summary.state === S.BREAK || summary.state === S.LUNCH)) {
      var label = summary.state === S.LUNCH ? 'lunch' : 'break';
      // If the phone suspended the keep-alive, the reminder the user is only
      // now seeing was due a while ago. Say so, rather than letting a late
      // reminder look like an unreliable one.
      var suffix = Notify.keepAliveWasInterrupted()
        ? ' Your phone paused the background timer, so this is only reaching you now — Settings explains how to stop that.'
        : '';
      UI.toast('You have been on ' + label + ' for ' + UI.shortDuration(summary.openMs) + '.' + suffix, 'warn');
    }
  }

  /* --------------------------------------------------------------- actions */

  function actStart() {
    if (currentState() !== 'IDLE') return;
    transition(S.WORKING);
    UI.toast('Clocked in at ' + UI.clockTime(Date.now()) + '.', 'ok');
  }

  function actResume() {
    var state = currentState();
    if (state !== S.BREAK && state !== S.LUNCH && state !== S.PAUSED) return;
    transition(S.WORKING);
    UI.toast('Back on the clock.', 'ok');
  }

  function actBreak() {
    if (currentState() !== S.WORKING) return;
    transition(S.BREAK);
    var mins = Store.settings().breakAlertMinutes;
    UI.toast('Break started. Reminder in ' + mins + ' min, then every ' +
      Store.settings().breakRepeatMinutes + ' min.', 'info');
  }

  function actLunch() {
    if (currentState() !== S.WORKING) return;
    transition(S.LUNCH);
    var mins = Store.settings().lunchAlertMinutes;
    UI.toast('Lunch started. Reminder in ' + mins + ' min, then every ' +
      Store.settings().lunchRepeatMinutes + ' min.', 'info');
  }

  function actPause() {
    if (currentState() !== S.WORKING) return;
    transition(S.PAUSED);
    UI.toast('Paused. This is not logged as a break.', 'info');
  }

  /**
   * Meetings are work: the time counts towards the daily target, and is also
   * tracked on its own so the split between desk work and meetings is visible.
   */
  function actMeeting() {
    var state = currentState();
    if (state !== S.WORKING && state !== 'IDLE') return;
    transition(S.MEETING);
    UI.toast('Meeting started. This still counts towards your day.', 'ok');
  }

  /**
   * A meeting that lands after the day was closed - the evening call you did
   * not plan for. It reopens nothing: the meeting is appended to the same day,
   * and finishing it puts the day back to closed.
   */
  function actLogMeeting() {
    if (currentState() !== S.ENDED) return;
    transition(S.MEETING);
    UI.toast('Meeting started. It will be added to today once you finish.', 'ok');
  }

  function actEndMeeting() {
    var day = currentDay();
    if (TL.currentState(day) !== S.MEETING) return;

    var afterHours = TL.previousState(day) === S.ENDED;
    var meetingMs = TL.summarize(day, Date.now()).openMs;

    transition(afterHours ? S.ENDED : S.WORKING);

    UI.toast(afterHours
      ? UI.shortDuration(meetingMs) + ' meeting added to today. Day closed again.'
      : UI.shortDuration(meetingMs) + ' meeting logged. Back on the clock.', 'ok');
  }

  /**
   * @param unattended  True when the request came from the lock screen. A
   *   `confirm()` cannot be answered by someone whose phone is locked - it
   *   would block on a dialog nobody can see - so that path skips it. Ending
   *   the day is recoverable either way: Reopen puts the clock back on without
   *   crediting the gap.
   */
  function actEndDay(unattended) {
    var state = currentState();
    if (state === 'IDLE' || state === S.ENDED) return;

    var summary = TL.summarize(currentDay(), Date.now());
    var message = 'End the day at ' + UI.clockTime(Date.now()) + ' with ' +
      UI.hm(summary.creditedMs) + ' logged?';
    if (unattended !== true && !confirm(message)) return;

    transition(S.ENDED);
    Notify.onBreakEnded();
    UI.toast('Day closed - ' + UI.hm(summary.creditedMs) + ' logged. Late meetings still get added.', 'ok');
  }

  /**
   * Go back on the clock after ending the day.
   *
   * This appends a fresh WORKING event rather than deleting the ENDED one, so
   * the hours between clocking off and changing your mind stay uncounted.
   */
  function actReopen() {
    if (currentState() !== S.ENDED) return;
    transition(S.WORKING);
    UI.toast('Back on the clock.', 'info');
  }

  /* ------------------------------------------------------------ day editing */

  function openDayDetails(dateKey) {
    UI.renderDayDetails(dateKey, Date.now());
    UI.openModal(el.logDetailsModal);
  }

  function openDayEditor(dateKey) {
    UI.closeModal(el.logDetailsModal);
    UI.fillEditForm(dateKey, Date.now());
    UI.openModal(el.editDayModal);
  }

  function saveDayEdit(event) {
    event.preventDefault();
    var dateKey = el.editDayForm.dataset.dateKey;
    if (!dateKey) return;

    var timeParts = (el.editStartTime.value || '09:00').split(':');
    var base = TL.dateFromKey(dateKey);
    base.setHours(Number(timeParts[0]) || 0, Number(timeParts[1]) || 0, 0, 0);

    var workMs = (Number(el.editWorkH.value) || 0) * 3600000 + (Number(el.editWorkM.value) || 0) * 60000;
    var meetingMs = (Number(el.editMeetingM.value) || 0) * 60000;
    var breakMs = (Number(el.editBreakM.value) || 0) * 60000;
    var lunchMs = (Number(el.editLunchM.value) || 0) * 60000;

    var totalMs = workMs + meetingMs + breakMs + lunchMs;

    if (totalMs > 24 * 3600000) {
      UI.toast('That is more than 24 hours in one day.', 'warn');
      return;
    }

    // A day may not be made to finish in the future. Saving "8h from 09:00" at
    // 11am used to stamp a clock-out at 17:00; every later tap was then forced
    // past it by the monotonic guard, freezing the timer and collapsing the
    // rest of the afternoon into one-second segments.
    var endsAt = base.getTime() + totalMs;
    if (endsAt > Date.now()) {
      UI.toast('That adds up to ' + UI.clockTime(endsAt) + ', which has not happened yet.', 'warn');
      return;
    }

    var day = TL.rebuildFromTotals(dateKey, {
      startMs: base.getTime(),
      workMs: workMs,
      meetingMs: meetingMs,
      breakMs: breakMs,
      lunchMs: lunchMs,
      note: el.editNote.value.trim()
    });

    Store.putDay(day);

    // Correcting a stale open day is how the recovery banner gets resolved.
    if (dateKey !== activeDayKey) openShiftDismissed = false;

    UI.closeModal(el.editDayModal);
    renderAll();
    UI.toast('Saved ' + UI.hm(workMs + meetingMs) + ' for ' + dateKey + '.', 'ok');
  }

  function deleteDay() {
    var dateKey = el.editDayForm.dataset.dateKey;
    if (!dateKey) return;
    if (!confirm('Delete the record for ' + dateKey + '? This cannot be undone.')) return;

    Store.deleteDay(dateKey);
    UI.closeModal(el.editDayModal);
    renderAll();
    UI.toast('Record deleted.', 'info');
  }

  /* -------------------------------------------------------------- profiles */

  /**
   * Re-pin the ongoing break notification for whatever day is now active.
   *
   * Needed anywhere the active day changes underneath a running break: a page
   * reload, a profile switch, a restored backup. Without it the pinned shade
   * entry and its "End break" action silently vanish for the rest of the break.
   */
  /**
   * Restore the reminder state for whatever is running right now.
   *
   * Also the self-heal for the server: re-arming on every open replaces a
   * record the server may have lost to a restart, and the disarm on the "not
   * resting" path clears one left behind by a break that was ended while the
   * phone had no signal.
   */
  function rearmRestingNotifications() {
    var summary = TL.summarize(currentDay(), Date.now());

    if (summary.state !== S.BREAK && summary.state !== S.LUNCH) {
      Push.disarm();
      return;
    }

    Notify.onBreakStarted(summary.state, summary.openSince);
    Notify.check(summary);
    armServerReminder(summary.state, summary.openSince);
  }

  /** Hand the break's deadline to the server. Fails soft by design. */
  function armServerReminder(state, since) {
    var s = Store.settings();
    var isLunch = state === S.LUNCH;
    Push.arm(
      isLunch ? 'LUNCH' : 'BREAK',
      since,
      isLunch ? s.lunchAlertMinutes : s.breakAlertMinutes,
      isLunch ? s.lunchRepeatMinutes : s.breakRepeatMinutes
    );
  }

  function switchPerson(id) {
    if (!Store.setActivePerson(id)) return;
    Notify.onBreakEnded();
    activeDayKey = today();
    openShiftDismissed = false;
    el.personDropdown.hidden = true;
    renderAll();
    rearmRestingNotifications();
    UI.toast('Switched to ' + Store.activePerson().name + '.', 'info');
  }

  function addPerson(event) {
    event.preventDefault();
    var name = el.personNameInput.value.trim();
    if (!name) return;

    Store.addPerson(name, el.personRoleInput.value.trim());
    Notify.onBreakEnded();
    activeDayKey = today();

    el.personNameInput.value = '';
    el.personRoleInput.value = '';
    UI.closeModal(el.addPersonModal);
    el.personDropdown.hidden = true;
    renderAll();
    UI.toast('Profile created.', 'ok');
  }

  /* -------------------------------------------------------------- settings */

  /** A minutes box: blank or nonsense keeps what was there, 0 means never. */
  function minutesField(input, fallback) {
    if (input.value === '') return fallback;
    var value = Number(input.value);
    if (!isFinite(value) || value < 0) return fallback;
    return Math.round(value);
  }

  /**
   * The one path that changes the theme, whichever control asked.
   *
   * The header button and the Appearance group are two views of one setting,
   * so both go through here and both are re-rendered afterwards - otherwise
   * using one leaves the other showing the theme you just left.
   */
  function setTheme(theme) {
    Store.updateSettings({ theme: theme });
    UI.applyTheme();
    UI.renderSettingsSummaries(Notify);
  }

  function saveSettings() {
    var hours = Number(el.setDailyTarget.value);
    if (!isFinite(hours) || hours <= 0 || hours > 24) {
      UI.toast('Daily target must be between 0 and 24 hours.', 'warn');
      el.setDailyTarget.value = (Store.settings().dailyTargetMinutes / 60).toString();
      return;
    }

    Store.updateSettings({
      dailyTargetMinutes: Math.round(hours * 60),
      breakAlertMinutes: Number(el.setBreakAlert.value) || 15,
      breakRepeatMinutes: Number(el.setBreakRepeat.value) || 5,
      lunchAlertMinutes: Number(el.setLunchAlert.value) || 30,
      lunchRepeatMinutes: Number(el.setLunchRepeat.value) || 5,
      keepAliveEnabled: el.setKeepAlive.checked,
      lockScreenControls: el.setLockScreen.checked,
      vibrate: el.setVibrate.checked,
      // A blank field is not a zero. Zero means "never nag me about this" and
      // has to survive being typed; an empty box means the person cleared it on
      // the way to typing something else, so it keeps the current value.
      stretchAlertMinutes: minutesField(el.setStretchAlert, Store.settings().stretchAlertMinutes),
      stretchRepeatMinutes: Math.max(1, minutesField(el.setStretchRepeat, Store.settings().stretchRepeatMinutes)),
      pauseAlertMinutes: minutesField(el.setPauseAlert, Store.settings().pauseAlertMinutes),
      meetingAlertMinutes: minutesField(el.setMeetingAlert, Store.settings().meetingAlertMinutes),
      overtimeReminder: el.setOvertimeReminder.checked
    });

    // Only the master switch stops the track here. Turning the card off while
    // a break is running must not kill the track that break's reminder needs -
    // the next tick releases it if nothing else wants it.
    if (!el.setKeepAlive.checked) Notify.stopKeepAlive();
    renderAll();
    // Collapsed group headers quote these values, so they have to move too.
    UI.renderSettingsSummaries(Notify);
  }

  function savePersonEdit() {
    var name = el.renamePersonInput.value.trim();
    if (!name) {
      UI.toast('A profile needs a name.', 'warn');
      return;
    }
    Store.renamePerson(Store.get().activePersonId, name, el.renamePersonRole.value.trim());
    renderAll();
    UI.toast('Profile updated.', 'ok');
  }

  function deleteCurrentPerson() {
    var person = Store.activePerson();
    if (Store.persons().length <= 1) {
      UI.toast('You need at least one profile.', 'warn');
      return;
    }
    if (!confirm('Delete "' + person.name + '" and all of their attendance records? This cannot be undone.')) return;

    Store.removePerson(person.id);
    activeDayKey = today();
    UI.closeModal(el.settingsModal);
    renderAll();
    UI.toast('Profile deleted.', 'info');
  }

  /* ------------------------------------------------------- export / import */

  /** Shared download path. A Blob, not a data: URI - long histories exceed
   *  URL length limits in some browsers and silently truncate the file. */
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /**
   * The spreadsheet people actually read: a daily log, the timeline behind it,
   * and monthly totals. Real dates and real numbers, so it can be sorted,
   * summed and pivoted without cleanup.
   */
  function exportExcel() {
    try {
      var now = Date.now();
      download(Report.buildWorkbook(now), Report.suggestedFilename(now));
      UI.toast('Excel file downloaded.', 'ok');
    } catch (e) {
      console.error('Track8: Excel export failed.', e);
      UI.toast('Could not build the Excel file. Take a JSON backup instead.', 'warn');
    }
  }

  /**
   * The JSON backup is the only format that can be restored - the spreadsheet
   * is for reading, not for round-tripping - so both are offered.
   */
  function exportData() {
    download(new Blob([Store.exportJSON()], { type: 'application/json' }),
      'track8-backup-' + today() + '.json');
    UI.toast('Backup downloaded. This is the file to keep for restoring.', 'ok');
  }

  function importData(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function () {
      try {
        Store.importJSON(String(reader.result));
        activeDayKey = today();
        openShiftDismissed = false;
        UI.closeModal(el.settingsModal);
        renderAll();
        Notify.onBreakEnded();
        rearmRestingNotifications();
        UI.toast('Backup restored.', 'ok');
      } catch (e) {
        console.error(e);
        UI.toast('That file could not be read as a Track8 backup.', 'warn');
      }
    };
    reader.onerror = function () { UI.toast('Could not read that file.', 'warn'); };
    reader.readAsText(file);
    event.target.value = '';
  }

  /* ------------------------------------------------------------- sign in */

  var signinEmail = '';
  var signinName = '';

  // What store.js calls a profile before anybody has named it.
  var DEFAULT_PROFILE_NAME = 'Me';

  /**
   * Put the typed name on the profile, but only if the profile has none.
   *
   * The name is a label, not a credential: it is never sent to the sign-in
   * endpoints and never decides whether a code is accepted, so typing it
   * differently next time cannot lock anyone out. It is also not allowed to
   * overwrite a name the user has since set inside the app, or on another
   * device - a typo at the sign-in screen would otherwise quietly rename them
   * everywhere. Runs after the first sync so that a name already on the
   * account has arrived and can win.
   */
  function applySigninName() {
    if (!signinName) return;
    var person = Store.activePerson();
    if (!person) return;
    if (person.name && person.name !== DEFAULT_PROFILE_NAME) return;

    Store.renamePerson(person.id, signinName, person.role || '');
    UI.renderPersonHeader();
    Sync.schedule('named', 300);
  }

  /**
   * Clear the form so a later sign-in starts clean.
   *
   * Without this the name box still held whatever was typed last time, which
   * after an in-app rename is the stale one - offering back a name the user
   * has already replaced.
   */
  function resetSigninForm() {
    signinEmail = '';
    signinName = '';
    el.signinName.value = '';
    el.signinEmail.value = '';
    el.signinCode.value = '';
    showSigninStep('email');
  }

  function showSigninError(message) {
    el.signinError.textContent = message;
    el.signinError.hidden = !message;
  }

  function showSigninStep(step) {
    el.signinEmailForm.hidden = step !== 'email';
    el.signinCodeForm.hidden = step !== 'code';
    showSigninError('');
    var focus = step === 'email' ? el.signinEmail : el.signinCode;
    setTimeout(function () { if (focus) focus.focus(); }, 80);
  }

  /**
   * Decide whether the gate stands in the way.
   *
   * Only when a sync server is actually reachable, nobody is signed in, and
   * the phone is online. Offline, the app opens straight to the timer and the
   * gate appears the next time it is launched with a connection - a code that
   * cannot be delivered is not a login, it is a locked door.
   */
  function updateSigninGate() {
    var s = Sync.status();
    var show = s.checked && s.available && !s.signedIn && s.online;
    el.signinScreen.hidden = !show;

    if (show) {
      // Someone who has already been using the app locally has a name; offer
      // it back rather than making them type it again.
      var person = Store.activePerson();
      if (person && person.name && person.name !== DEFAULT_PROFILE_NAME && !el.signinName.value) {
        el.signinName.value = person.name;
      }
      if (el.signinCodeForm.hidden && el.signinEmailForm.hidden) showSigninStep('email');
    } else {
      // The one moment we know nothing is about to cover the screen. Sync
      // always answers — with a server, without one, or offline — so this runs
      // on every launch, and what it opens only fires on the first.
      maybeOnboard();
    }
  }

  /**
   * First launch: ask for the timers, then walk through the app.
   *
   * In that order deliberately. The walkthrough points at a dial that is about
   * to be measured against whatever target is set here, and being asked for
   * three numbers before anything has been explained is a shorter first screen
   * than being shown seven and then asked to go and find them.
   */
  function maybeOnboard() {
    if (!Store.seen('setup')) {
      if (document.querySelector('.modal-overlay.open')) return;
      UI.fillSetupForm();
      UI.openModal(el.setupModal);
      return;
    }
    UI.maybeStartTour();
  }

  function finishSetup(save) {
    if (save) {
      var target = Number(el.setupTarget.value);
      if (!isFinite(target) || target <= 0 || target > 24) {
        UI.toast('Hours a day must be between 0 and 24.', 'warn');
        return;
      }
      Store.updateSettings({
        dailyTargetMinutes: Math.round(target * 60),
        breakAlertMinutes: Math.max(1, Number(el.setupBreak.value) || 15),
        lunchAlertMinutes: Math.max(1, Number(el.setupLunch.value) || 30)
      });
      renderAll();
      UI.renderSettingsSummaries(Notify);
    }

    Store.markSeen('setup');
    UI.closeModal(el.setupModal);
    // Straight into the walkthrough, which is the other thing this launch owes
    // the user. closeModal hands focus back first, so this cannot race it.
    UI.maybeStartTour();
  }

  function sendSigninCode(event) {
    if (event) event.preventDefault();
    var email = el.signinEmail.value.trim();
    if (!email) return;

    signinName = el.signinName.value.trim();

    el.signinSendBtn.disabled = true;
    el.signinSendBtn.textContent = 'Sending…';
    showSigninError('');

    Sync.requestCode(email)
      .then(function () {
        signinEmail = email;
        el.signinSentTo.textContent = email;
        el.signinCode.value = '';
        showSigninStep('code');
      })
      .catch(function (e) {
        showSigninError(e.message || 'Could not send the code. Try again.');
      })
      .then(function () {
        el.signinSendBtn.disabled = false;
        el.signinSendBtn.textContent = 'Send me a code';
      });
  }

  function verifySigninCode(event) {
    if (event) event.preventDefault();
    var code = el.signinCode.value.trim();
    if (!/^\d{6}$/.test(code)) {
      showSigninError('Enter the 6-digit code from the email.');
      return;
    }

    el.signinVerifyBtn.disabled = true;
    el.signinVerifyBtn.textContent = 'Signing in…';

    Sync.verifyCode(signinEmail, code)
      .then(function () {
        el.signinScreen.hidden = true;
        UI.toast('Signed in. Your hours are being saved.', 'ok');
        // Uploads everything already on this device, then pulls anything the
        // account already had.
        return Sync.run('after-signin');
      })
      .then(function () {
        // After the pull, so a name already on the account wins over the one
        // just typed.
        applySigninName();
        renderAll();
      })
      .catch(function (e) {
        showSigninError(e.message || 'That did not work. Try again.');
      })
      .then(function () {
        el.signinVerifyBtn.disabled = false;
        el.signinVerifyBtn.textContent = 'Sign in';
      });
  }

  /* ------------------------------------------------------- change email */

  var pendingNewEmail = '';

  function resetEmailChange() {
    pendingNewEmail = '';
    el.newEmailInput.value = '';
    el.newEmailCode.value = '';
    el.newEmailCodeGroup.hidden = true;
    el.newEmailInput.disabled = false;
    el.confirmNewEmailBtn.hidden = true;
    el.sendNewEmailCodeBtn.hidden = false;
    el.emailChangeNote.textContent =
      'Your hours stay exactly where they are. Every signed-in device stays signed in.';
  }

  function sendNewEmailCode() {
    var email = el.newEmailInput.value.trim();
    if (!email) return;

    el.sendNewEmailCodeBtn.disabled = true;
    Sync.requestEmailChange(email)
      .then(function () {
        pendingNewEmail = email;
        // Locked while a code is outstanding: the code was sent to this
        // address, and confirming against a different one would just fail.
        el.newEmailInput.disabled = true;
        el.newEmailCodeGroup.hidden = false;
        el.sendNewEmailCodeBtn.hidden = true;
        el.confirmNewEmailBtn.hidden = false;
        el.emailChangeNote.textContent = 'We sent a code to ' + email + '. Enter it to confirm.';
        el.newEmailCode.focus();
      })
      .catch(function (e) {
        el.emailChangeNote.textContent = e.message || 'Could not send a code to that address.';
      })
      .then(function () { el.sendNewEmailCodeBtn.disabled = false; });
  }

  function confirmNewEmail() {
    var code = el.newEmailCode.value.trim();
    if (!/^\d{6}$/.test(code)) {
      el.emailChangeNote.textContent = 'Enter the 6-digit code.';
      return;
    }

    el.confirmNewEmailBtn.disabled = true;
    Sync.confirmEmailChange(pendingNewEmail, code)
      .then(function (data) {
        el.emailChangePanel.hidden = true;
        resetEmailChange();
        UI.fillSettingsForm(Notify);
        UI.toast('Your email is now ' + data.email + '.', 'ok');
      })
      .catch(function (e) {
        el.emailChangeNote.textContent = e.message || 'That code did not work.';
      })
      .then(function () { el.confirmNewEmailBtn.disabled = false; });
  }

  /* --------------------------------------------------------- notifications */

  function enableNotifications() {
    Notify.requestPermission().then(function (permission) {
      Store.updateSettings({ notificationsEnabled: permission === 'granted' });
      UI.renderReminderStatus(Notify);
      UI.fillSettingsForm(Notify);

      if (permission === 'granted') {
        // Subscribing needs permission, so this is the first moment it can
        // succeed. Re-arm afterwards in case a break is already running.
        Push.connect().then(function () {
          rearmRestingNotifications();
          UI.fillSettingsForm(Notify);
        });

        Notify.show('🔔 Reminders are on', {
          body: 'When a break passes ' + Store.settings().breakAlertMinutes +
            ' minutes you will be reminded here, then every ' +
            Store.settings().breakRepeatMinutes + ' minutes until you clock back in.',
          tag: 't8-setup',
          icon: './icons/icon-192.png',
          badge: './icons/badge-72.png'
        });
      } else if (permission === 'denied') {
        // Blocked is a dead end from JavaScript, so send the user somewhere
        // that explains the way out rather than firing a toast that only
        // restates the problem.
        openSettingsAt('reminders', true);
        UI.toast('Notifications are blocked. Here is how to switch them back on.', 'warn');
      }
    });
  }

  /**
   * Notice a permission change made outside the app.
   *
   * There is no way to send the user to the browser's notification settings,
   * so the next best thing is to make coming back seamless: the moment the
   * user flips the switch in system settings, this fires and the blocked card
   * turns itself into the "on" card with no reload and no second tap. Chrome,
   * Edge and Firefox support it; Safari does not, which is why the visible
   * "Check again" button exists as well.
   */
  function watchPermission() {
    if (!navigator.permissions || !navigator.permissions.query) return;
    try {
      navigator.permissions.query({ name: 'notifications' }).then(function (status) {
        status.onchange = function () {
          Store.updateSettings({ notificationsEnabled: Notify.granted() });
          UI.renderReminderStatus(Notify);
          if (!el.settingsModal.hidden) UI.fillSettingsForm(Notify);
          if (Notify.granted()) UI.toast('Reminders are on.', 'ok');
        };
      }).catch(function () { /* not queryable on this browser */ });
    } catch (e) {
      // Older WebViews throw on an unknown permission name rather than
      // rejecting. Nothing to do: the "Check again" button covers it.
    }
  }

  function recheckPermission() {
    UI.renderReminderStatus(Notify);
    UI.fillSettingsForm(Notify);
    if (Notify.granted()) {
      Store.updateSettings({ notificationsEnabled: true });
      UI.toast('Reminders are on now.', 'ok');
    } else {
      UI.toast('Still blocked. The steps above have to be done in your phone settings, not here.', 'warn');
    }
  }

  function copySiteAddress() {
    var url = global.location.origin + global.location.pathname;
    var done = function (ok) {
      UI.toast(ok ? 'Address copied.' : 'Could not copy — select the address and copy it by hand.', ok ? 'ok' : 'warn');
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
      return;
    }

    // Clipboard API needs a secure context and is missing on older WebViews.
    try {
      var field = document.createElement('textarea');
      field.value = url;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      done(document.execCommand('copy'));
      document.body.removeChild(field);
    } catch (e) {
      done(false);
    }
  }

  /* ------------------------------------------------------- settings groups */

  /** One group open at a time: the sheet stays short enough to scan. */
  function toggleSettingsGroup(group, force) {
    var open = force == null ? !group.classList.contains('open') : force;

    if (open) {
      el.settingsBody.querySelectorAll('.settings-group').forEach(function (other) {
        if (other === group) return;
        other.classList.remove('open');
        other.querySelector('.settings-group-header').setAttribute('aria-expanded', 'false');
      });
    }

    group.classList.toggle('open', open);
    group.querySelector('.settings-group-header').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /**
   * Open settings, optionally showing one group and nothing else.
   *
   * Scoped is how the header bell opens it: a bell that lands on six collapsed
   * groups makes the user hunt for the one it is named after. The markup is
   * the same either way - only a data-only attribute and the title change - so
   * every control inside keeps its single binding.
   */
  function openSettingsAt(groupName, onlyThisGroup) {
    UI.fillSettingsForm(Notify);
    UI.openModal(el.settingsModal);

    // Guarded for the same reason as bindIfPresent: against an index.html that
    // predates this release, the sheet simply opens unscoped rather than
    // throwing and leaving the modal half-configured.
    if (onlyThisGroup) {
      el.settingsBody.setAttribute('data-only', groupName);
      if (el.settingsTitle) el.settingsTitle.textContent = SETTINGS_GROUP_TITLE[groupName] || 'Settings';
      if (el.showAllSettingsBtn) el.showAllSettingsBtn.hidden = false;
    } else {
      showAllSettings();
    }

    var group = el.settingsBody.querySelector('[data-group="' + groupName + '"]');
    if (group) toggleSettingsGroup(group, true);
  }

  var SETTINGS_GROUP_TITLE = {
    reminders: 'Notifications',
    workday: 'Work day',
    profile: 'Profile',
    account: 'Account & sync',
    data: 'Data & backup',
    install: 'Install'
  };

  function showAllSettings() {
    el.settingsBody.removeAttribute('data-only');
    if (el.settingsTitle) el.settingsTitle.textContent = 'Settings';
    if (el.showAllSettingsBtn) el.showAllSettingsBtn.hidden = true;
  }

  function testNotification() {
    // Fired before the notification so the buzz is not attributed to it: the
    // two are separate mechanisms and either can fail on its own.
    var buzzed = Notify.buzz();

    Notify.show('☕ Break running 15 min', {
      body: 'This is what a reminder looks like. Tap "End break" to clock back in.',
      tag: 't8-nag',
      renotify: true,
      requireInteraction: true,
      vibrate: Store.settings().vibrate ? [200, 100, 200] : undefined,
      icon: './icons/icon-192.png',
      badge: './icons/badge-72.png',
      data: { kind: 'test' },
      actions: [{ action: 'resume', title: 'End break' }]
    }).then(function (shown) {
      if (!shown) {
        UI.toast('Could not show a notification on this device.', 'warn');
        return;
      }
      if (!Store.settings().vibrate) {
        UI.toast('Test reminder sent. Vibration is switched off in settings.', 'ok');
      } else if (!Notify.vibrationSupported()) {
        UI.toast('Test reminder sent. This device has no vibration API — iPhones do not allow it.', 'ok');
      } else if (!buzzed) {
        UI.toast('Test reminder sent, but the phone refused to vibrate. Check silent mode and Do Not Disturb.', 'warn');
      } else {
        UI.toast('Test reminder sent, and it buzzed.', 'ok');
      }
    });
  }

  /* ------------------------------------------------------------- listeners */

  function bind() {
    el.btnStart.addEventListener('click', actStart);
    el.btnResume.addEventListener('click', actResume);
    el.btnBreak.addEventListener('click', actBreak);
    el.btnLunch.addEventListener('click', actLunch);
    el.btnPause.addEventListener('click', actPause);
    el.btnMeeting.addEventListener('click', actMeeting);
    el.btnLogMeeting.addEventListener('click', actLogMeeting);
    el.btnEndMeeting.addEventListener('click', actEndMeeting);
    el.btnEnd.addEventListener('click', function () { actEndDay(false); });
    el.btnReopen.addEventListener('click', actReopen);
    el.btnEditToday.addEventListener('click', function () { openDayEditor(activeDayKey); });
    el.dialToggle.addEventListener('click', function () {
      UI.toggleDialMode();
      renderAll();
    });
    el.breakBannerAction.addEventListener('click', actResume);

    // Views
    document.querySelectorAll('.bottom-nav .nav-item[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () { UI.showView(btn.getAttribute('data-view')); });
    });

    // Profile dropdown
    el.personSelectBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      UI.renderPersonList();
      el.personDropdown.hidden = !el.personDropdown.hidden;
    });
    el.personDropdown.addEventListener('click', function (event) {
      var item = event.target.closest('[data-person-id]');
      if (item) switchPerson(item.getAttribute('data-person-id'));
    });
    document.addEventListener('click', function (event) {
      if (!el.personDropdown.hidden && !event.target.closest('.person-selector-wrapper')) {
        el.personDropdown.hidden = true;
      }
    });

    el.openAddPersonModal.addEventListener('click', function () {
      el.personDropdown.hidden = true;
      UI.openModal(el.addPersonModal);
    });
    el.addPersonForm.addEventListener('submit', addPerson);
    el.closeAddPersonModal.addEventListener('click', function () { UI.closeModal(el.addPersonModal); });
    el.cancelAddPerson.addEventListener('click', function () { UI.closeModal(el.addPersonModal); });

    // Week and month navigation. Forward is disabled by the renderers once the
    // anchor reaches the current period; the guards here repeat that in code,
    // because a disabled attribute is a hint to the pointer and not a rule.
    //
    // Bound through bindIfPresent because these controls arrived after the
    // version some browsers may still be holding. A rolling deploy can serve a
    // cached or old-instance index.html alongside this file for a few seconds,
    // and binding straight onto a missing node threw out of init - which left
    // everything below this line unbound, so the timer still ran but settings,
    // sync and export were all dead until the next reload.
    bindIfPresent(el.prevWeekBtn, 'click', function () {
      weekAnchor.setDate(weekAnchor.getDate() - 7);
      UI.renderWeek(weekAnchor, Date.now());
    });
    bindIfPresent(el.nextWeekBtn, 'click', function () {
      var now = Date.now();
      var forward = new Date(weekAnchor.getTime());
      forward.setDate(forward.getDate() + 7);
      // Monday of the week being moved into: stepping onto the current week is
      // allowed, stepping past it is not.
      if (startOfWeekMs(forward) > startOfWeekMs(new Date(now))) return;
      weekAnchor = forward;
      UI.renderWeek(weekAnchor, now);
    });
    bindIfPresent(el.thisWeekBtn, 'click', function () {
      weekAnchor = new Date();
      UI.renderWeek(weekAnchor, Date.now());
    });

    el.prevMonthBtn.addEventListener('click', function () {
      monthAnchor.setDate(1);
      monthAnchor.setMonth(monthAnchor.getMonth() - 1);
      UI.renderCalendar(monthAnchor, Date.now());
    });
    el.nextMonthBtn.addEventListener('click', function () {
      var today = new Date();
      var forward = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 1);
      if (forward.getFullYear() > today.getFullYear() ||
        (forward.getFullYear() === today.getFullYear() && forward.getMonth() > today.getMonth())) return;
      monthAnchor = forward;
      UI.renderCalendar(monthAnchor, Date.now());
    });
    bindIfPresent(el.thisMonthBtn, 'click', function () {
      monthAnchor = new Date();
      UI.renderCalendar(monthAnchor, Date.now());
    });

    // A bar is a button carrying its own date, so the week chart opens the
    // same day sheet the calendar does - and that sheet is where "Correct this
    // day" lives. Delegated, because renderWeek replaces the columns.
    el.histogramBars.addEventListener('click', function (event) {
      var col = event.target.closest('[data-date-key]');
      if (col && !col.disabled) openDayDetails(col.getAttribute('data-date-key'));
    });

    // Calendar day selection, keyboard included
    el.calendarDays.addEventListener('click', function (event) {
      var cell = event.target.closest('[data-date-key]');
      if (cell) openDayDetails(cell.getAttribute('data-date-key'));
    });
    el.calendarDays.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var cell = event.target.closest('[data-date-key]');
      if (!cell) return;
      event.preventDefault();
      openDayDetails(cell.getAttribute('data-date-key'));
    });

    // Day detail and editor
    el.logDetailsBody.addEventListener('click', function (event) {
      var trigger = event.target.closest('[data-edit-day]');
      if (trigger) openDayEditor(trigger.getAttribute('data-edit-day'));
    });
    el.closeLogDetailsModal.addEventListener('click', function () { UI.closeModal(el.logDetailsModal); });
    el.editDayForm.addEventListener('submit', saveDayEdit);
    el.closeEditDayModal.addEventListener('click', function () { UI.closeModal(el.editDayModal); });
    el.cancelEditDay.addEventListener('click', function () { UI.closeModal(el.editDayModal); });
    el.deleteDayBtn.addEventListener('click', deleteDay);

    // Open-shift recovery
    el.openShiftEndBtn.addEventListener('click', function () {
      var key = el.openShiftBanner.dataset.dateKey;
      if (key) openDayEditor(key);
    });
    el.openShiftDismissBtn.addEventListener('click', function () {
      openShiftDismissed = true;
      el.openShiftBanner.hidden = true;
    });

    // Settings. The nav tab opens the whole sheet; the header bell opens it
    // scoped to reminders, so clear any leftover scope here.
    el.openSettingsBtn.addEventListener('click', function () {
      UI.fillSettingsForm(Notify);
      UI.openModal(el.settingsModal);
      showAllSettings();
    });
    el.closeSettingsModal.addEventListener('click', function () { UI.closeModal(el.settingsModal); });
    bindIfPresent(el.showAllSettingsBtn, 'click', showAllSettings);

    // Accordion. Delegated, so the group markup can change without rebinding.
    el.settingsBody.addEventListener('click', function (event) {
      var header = event.target.closest('.settings-group-header');
      if (!header) return;
      toggleSettingsGroup(header.parentNode);
    });

    [el.setDailyTarget, el.setBreakAlert, el.setBreakRepeat, el.setLunchAlert, el.setLunchRepeat,
      el.setStretchAlert, el.setStretchRepeat, el.setPauseAlert, el.setMeetingAlert,
      el.setOvertimeReminder, el.setKeepAlive, el.setLockScreen, el.setVibrate].forEach(function (input) {
      input.addEventListener('change', saveSettings);
    });
    // Easter egg: five taps on the logo swap the reminder wording to Tanglish,
    // and five more put it back. Not in the settings screen on purpose - the
    // default has to be a plain reminder that anyone can act on.
    var LOGO_TAPS = 5;
    var logoTaps = 0;
    var logoTapTimer = null;
    el.brandLogo.addEventListener('click', function () {
      clearTimeout(logoTapTimer);
      logoTaps++;
      logoTapTimer = setTimeout(function () { logoTaps = 0; }, 2500);

      if (logoTaps < LOGO_TAPS) {
        // Silent for the first two, so an ordinary tap on the logo does not
        // announce a secret. From three on it counts down, which is the only
        // way anyone finds this without being told.
        var left = LOGO_TAPS - logoTaps;
        if (logoTaps >= 3) UI.toast(left + ' more tap' + (left === 1 ? '' : 's') + '…', 'info');
        return;
      }

      logoTaps = 0;
      var on = !Store.settings().tanglishReminders;
      Store.updateSettings({ tanglishReminders: on });
      UI.renderTanglishState();
      UI.toast(on
        ? '🎉 Tanglish reminders on. Vaanga, vela pakkalam!'
        : 'Reminders back to plain English.', 'ok');
    });

    // Theme picker. Delegated, so the three buttons need no individual wiring.
    el.settingsBody.addEventListener('click', function (event) {
      var option = event.target.closest('[data-theme-choice]');
      if (!option) return;
      setTheme(option.getAttribute('data-theme-choice'));
    });

    // The header shortcut. Same setting, one button, so it cycles rather than
    // toggles - dropping "match phone" would take away the only mode that
    // changes by itself at sunset.
    bindIfPresent(el.themeBtn, 'click', function () { setTheme(UI.nextTheme()); });

    el.setupSaveBtn.addEventListener('click', function () { finishSetup(true); });
    el.setupSkipBtn.addEventListener('click', function () { finishSetup(false); });

    el.replayTourBtn.addEventListener('click', function () {
      UI.closeModal(el.settingsModal);
      UI.startTour();
    });

    el.savePersonBtn.addEventListener('click', savePersonEdit);
    el.deletePersonBtn.addEventListener('click', deleteCurrentPerson);

    el.syncNowBtn.addEventListener('click', function () {
      UI.toast('Syncing…', 'info');
      Sync.run('manual').then(function () {
        var s = Sync.status();
        UI.toast(s.lastSyncOk ? 'Synced.' : 'Sync failed: ' + s.error, s.lastSyncOk ? 'ok' : 'warn');
        UI.fillSettingsForm(Notify);
      });
    });

    el.changeEmailBtn.addEventListener('click', function () {
      var opening = el.emailChangePanel.hidden;
      el.emailChangePanel.hidden = !opening;
      if (opening) {
        resetEmailChange();
        el.newEmailInput.focus();
      }
    });
    el.sendNewEmailCodeBtn.addEventListener('click', sendNewEmailCode);
    el.confirmNewEmailBtn.addEventListener('click', confirmNewEmail);
    el.cancelEmailChangeBtn.addEventListener('click', function () {
      el.emailChangePanel.hidden = true;
      resetEmailChange();
    });

    el.exportExcelBtn.addEventListener('click', exportExcel);
    el.exportBtn.addEventListener('click', exportData);
    el.importBtn.addEventListener('click', function () { el.importFileInput.click(); });
    el.importFileInput.addEventListener('change', importData);

    el.notifyBtn.addEventListener('click', function () {
      // Blocked goes to the explanation, not to a prompt that cannot appear.
      if (Notify.permission() === 'granted' || Notify.permission() === 'denied') {
        openSettingsAt('reminders', true);
      } else {
        enableNotifications();
      }
    });
    el.enableNotifyBtn.addEventListener('click', enableNotifications);
    el.recheckNotifyBtn.addEventListener('click', recheckPermission);
    el.copySiteBtn.addEventListener('click', copySiteAddress);
    el.testNotifyBtn.addEventListener('click', testNotification);

    // Modals: backdrop click and Escape both close.
    document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) UI.closeModal(overlay);
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      document.querySelectorAll('.modal-overlay.open').forEach(function (m) { UI.closeModal(m); });
      el.personDropdown.hidden = true;
    });

    // Sign in
    el.signinEmailForm.addEventListener('submit', sendSigninCode);
    el.signinCodeForm.addEventListener('submit', verifySigninCode);
    el.signinResendBtn.addEventListener('click', function () {
      el.signinEmail.value = signinEmail;
      sendSigninCode();
    });
    el.signinBackBtn.addEventListener('click', function () { showSigninStep('email'); });
    el.signOutBtn.addEventListener('click', function () {
      if (!global.confirm('Sign out? Your hours stay on this device, and stop syncing.')) return;
      Sync.signOut().then(function () {
        resetSigninForm();
        UI.fillSettingsForm(Notify);
        updateSigninGate();
      });
    });

    // Visibility and wake
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') onBecameVisible();
    });
    global.addEventListener('pageshow', onBecameVisible);
    global.addEventListener('focus', onBecameVisible);

    // Install to home screen
    global.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      deferredInstallPrompt = event;
      el.installBtn.hidden = false;
      el.installHint.hidden = true;
    });
    el.installBtn.addEventListener('click', function () {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(function (choice) {
        if (choice.outcome === 'accepted') {
          el.installBtn.hidden = true;
          UI.toast('Installed. Open Track8 from your home screen from now on.', 'ok');
        }
        deferredInstallPrompt = null;
      });
    });
    global.addEventListener('appinstalled', function () {
      el.installBtn.hidden = true;
      el.installHint.hidden = true;
    });
  }

  /** Handle ?a=resume, set when a notification action reopens a closed app. */
  function consumeLaunchAction() {
    var params = new URLSearchParams(global.location.search);
    if (params.get('a') !== 'resume') return;

    var state = currentState();
    if (state === S.BREAK || state === S.LUNCH) {
      actResume();
    }
    history.replaceState({}, '', global.location.pathname);
  }

  /* ------------------------------------------------------------------ boot */

  function init() {
    el = UI.cache();
    Store.load();

    activeDayKey = today();
    reconcile(Date.now(), true);

    bind();
    UI.showView('timer');
    UI.applyTheme();
    UI.renderTanglishState();
    renderAll();

    watchPermission();

    // Sync tells us whether a server is even there. Until it answers, the gate
    // stays hidden - flashing a sign-in screen at someone on a static host
    // would be a lie.
    Sync.onChange(function () {
      updateSigninGate();
      if (!el.settingsModal.hidden) UI.fillSettingsForm(Notify);
    });
    Sync.init();

    // The lock-screen card's buttons. Each one is the same function the timer
    // screen's button calls, so a tap from the lock screen is indistinguishable
    // from a tap in the app - it saves, re-renders and re-arms identically.
    // The transport buttons toggle, because the lock screen has one of each and
    // the answer to "what does Break do while I am on a break?" has to be
    // "ends it" rather than nothing.
    Notify.init({
      onResumeRequest: actResume,
      onPlayRequest: function () {
        if (currentState() === 'IDLE') actStart(); else actResume();
      },
      onPauseRequest: actPause,
      onBreakRequest: function () {
        if (currentState() === S.BREAK) actResume(); else actBreak();
      },
      onLunchRequest: function () {
        if (currentState() === S.LUNCH) actResume(); else actLunch();
      },
      onEndDayRequest: function () { actEndDay(true); }
    }).then(function (registration) {
      UI.renderReminderStatus(Notify);
      consumeLaunchAction();

      // Subscribe before re-arming, so a break already running is handed to
      // the server on this launch rather than the next one.
      return Push.connect(registration).then(function () {
        // A break restored across a reload re-arms its keep-alive and ongoing
        // notification, so closing the tab mid-break does not silence reminders.
        rearmRestingNotifications();
        UI.renderReminderStatus(Notify);
      });
    });

    startTicking();
  }

  // Sync applies changes straight into the store, so the screen has to be told
  // that the day it is drawing may have been rewritten by another device.
  global.T8App = {
    onSyncApplied: function () {
      renderAll();
      rearmRestingNotifications();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
