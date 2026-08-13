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

    Store.save();

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

  function actEndDay() {
    var state = currentState();
    if (state === 'IDLE' || state === S.ENDED) return;

    var summary = TL.summarize(currentDay(), Date.now());
    var message = 'End the day at ' + UI.clockTime(Date.now()) + ' with ' +
      UI.hm(summary.creditedMs) + ' logged?';
    if (!confirm(message)) return;

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
      vibrate: el.setVibrate.checked
    });

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
        openSettingsAt('reminders');
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

  function openSettingsAt(groupName) {
    UI.fillSettingsForm(Notify);
    UI.openModal(el.settingsModal);
    var group = el.settingsBody.querySelector('[data-group="' + groupName + '"]');
    if (group) toggleSettingsGroup(group, true);
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
    el.btnEnd.addEventListener('click', actEndDay);
    el.btnReopen.addEventListener('click', actReopen);
    el.btnEditToday.addEventListener('click', function () { openDayEditor(activeDayKey); });
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

    // Week and month navigation
    document.getElementById('prevWeekBtn').addEventListener('click', function () {
      weekAnchor.setDate(weekAnchor.getDate() - 7);
      UI.renderWeek(weekAnchor, Date.now());
    });
    document.getElementById('nextWeekBtn').addEventListener('click', function () {
      weekAnchor.setDate(weekAnchor.getDate() + 7);
      UI.renderWeek(weekAnchor, Date.now());
    });
    el.prevMonthBtn.addEventListener('click', function () {
      monthAnchor.setDate(1);
      monthAnchor.setMonth(monthAnchor.getMonth() - 1);
      UI.renderCalendar(monthAnchor, Date.now());
    });
    el.nextMonthBtn.addEventListener('click', function () {
      monthAnchor.setDate(1);
      monthAnchor.setMonth(monthAnchor.getMonth() + 1);
      UI.renderCalendar(monthAnchor, Date.now());
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

    // Settings
    el.openSettingsBtn.addEventListener('click', function () {
      UI.fillSettingsForm(Notify);
      UI.openModal(el.settingsModal);
    });
    el.closeSettingsModal.addEventListener('click', function () { UI.closeModal(el.settingsModal); });

    // Accordion. Delegated, so the group markup can change without rebinding.
    el.settingsBody.addEventListener('click', function (event) {
      var header = event.target.closest('.settings-group-header');
      if (!header) return;
      toggleSettingsGroup(header.parentNode);
    });

    [el.setDailyTarget, el.setBreakAlert, el.setBreakRepeat, el.setLunchAlert, el.setLunchRepeat,
      el.setKeepAlive, el.setVibrate].forEach(function (input) {
      input.addEventListener('change', saveSettings);
    });
    el.savePersonBtn.addEventListener('click', savePersonEdit);
    el.deletePersonBtn.addEventListener('click', deleteCurrentPerson);

    el.exportExcelBtn.addEventListener('click', exportExcel);
    el.exportBtn.addEventListener('click', exportData);
    el.importBtn.addEventListener('click', function () { el.importFileInput.click(); });
    el.importFileInput.addEventListener('change', importData);

    el.notifyBtn.addEventListener('click', function () {
      // Blocked goes to the explanation, not to a prompt that cannot appear.
      if (Notify.permission() === 'granted' || Notify.permission() === 'denied') {
        openSettingsAt('reminders');
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
    renderAll();

    watchPermission();

    Notify.init({ onResumeRequest: actResume }).then(function (registration) {
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
