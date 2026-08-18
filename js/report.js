/**
 * Track8 - Excel report
 *
 * Turns the stored event logs into three worksheets:
 *
 *   Daily log        one row per day, the sheet you would send to a manager
 *   Timeline         one row per activity span, the audit trail behind it
 *   Monthly summary  totals and balance per person per month
 *
 * Everything numeric is written as a real number so the columns can be summed
 * and pivoted. Hours are decimal (7.75, not "7h 45m") for the same reason; the
 * readable form already exists in the app.
 */
(function (global) {
  'use strict';

  var TL = global.T8Timeline;
  var Store = global.T8Store;
  var Xlsx = global.T8Xlsx;

  var ACTIVITY_LABEL = {
    WORKING: 'Work',
    MEETING: 'Meeting',
    BREAK: 'Short break',
    LUNCH: 'Lunch',
    PAUSED: 'Paused'
  };

  function hours(ms) {
    return Math.round((ms / 3600000) * 100) / 100;
  }

  function minutes(ms) {
    return Math.round(ms / 60000);
  }

  function statusOf(record) {
    if (record.day.autoEnded) return 'Auto-closed at 10pm - check in app';
    if (record.clamped) return 'Never ended - fix in app';
    if (record.day.imported) return 'Imported';
    if (!record.summary.ended) return 'Still open';
    return 'Closed';
  }

  /**
   * Every day of every profile, oldest first, with its summary attached.
   *
   * A still-running day is measured up to `now`, but never past the point it
   * stops accruing - 10pm on its own date. Without that clamp, a shift someone
   * forgot to end last Tuesday would export as hundreds of hours, and would
   * disagree with the app, which clamps the same way on every screen.
   */
  function collect(now) {
    var state = Store.get();
    var rows = [];

    state.persons.forEach(function (person) {
      var days = state.days[person.id] || {};
      Object.keys(days).sort().forEach(function (key) {
        var day = days[key];
        if (!day || !day.events || !day.events.length) return;

        var cutoff = TL.autoEndOf(day.dateKey, day);
        var measuredAt = Math.min(now, cutoff);

        rows.push({
          person: person,
          day: day,
          date: TL.dateFromKey(day.dateKey),
          measuredAt: measuredAt,
          clamped: TL.isRunning(day) && now > cutoff,
          summary: TL.summarize(day, measuredAt)
        });
      });
    });

    return rows;
  }

  function dailySheet(records, targetMs) {
    var rows = records.map(function (record) {
      var s = record.summary;
      return [
        record.person.name,
        record.date,
        record.date.toLocaleDateString('en-GB', { weekday: 'long' }),
        s.firstIn || null,
        s.lastOut || null,
        hours(s.workMs),
        hours(s.meetingMs),
        hours(s.creditedMs),
        hours(targetMs),
        hours(s.creditedMs - targetMs),
        minutes(s.breakMs),
        minutes(s.lunchMs),
        minutes(s.pausedMs),
        statusOf(record),
        record.day.note || ''
      ];
    });

    return {
      name: 'Daily log',
      columns: [
        { header: 'Person', width: 18, type: 'text' },
        { header: 'Date', width: 12, type: 'date' },
        { header: 'Weekday', width: 11, type: 'text' },
        { header: 'Clock in', width: 10, type: 'time' },
        { header: 'Clock out', width: 10, type: 'time' },
        { header: 'Work (h)', width: 10, type: 'number' },
        { header: 'Meetings (h)', width: 13, type: 'number' },
        { header: 'Counted (h)', width: 12, type: 'number' },
        { header: 'Target (h)', width: 11, type: 'number' },
        { header: 'Balance (h)', width: 12, type: 'number' },
        { header: 'Breaks (min)', width: 13, type: 'int' },
        { header: 'Lunch (min)', width: 12, type: 'int' },
        { header: 'Paused (min)', width: 13, type: 'int' },
        { header: 'Status', width: 12, type: 'text' },
        { header: 'Note', width: 30, type: 'text' }
      ],
      rows: rows
    };
  }

  function timelineSheet(records) {
    var rows = [];

    records.forEach(function (record) {
      // record.measuredAt is already clamped in collect(); reuse it so the
      // spans always add up to the daily totals.
      TL.segmentsOf(record.day, record.measuredAt).forEach(function (segment) {
        rows.push([
          record.person.name,
          record.date,
          ACTIVITY_LABEL[segment.state] || segment.state,
          segment.from,
          segment.to,
          hours(segment.ms),
          minutes(segment.ms)
        ]);
      });
    });

    return {
      name: 'Timeline',
      columns: [
        { header: 'Person', width: 18, type: 'text' },
        { header: 'Date', width: 12, type: 'date' },
        { header: 'Activity', width: 14, type: 'text' },
        { header: 'From', width: 10, type: 'time' },
        { header: 'To', width: 10, type: 'time' },
        { header: 'Duration (h)', width: 13, type: 'number' },
        { header: 'Duration (min)', width: 15, type: 'int' }
      ],
      rows: rows
    };
  }

  /**
   * Per person per month. The target counts weekdays that have a record plus
   * weekdays already elapsed in the month, matching what the app shows on
   * screen - a month is not judged against days that have not happened yet.
   */
  function summarySheet(records, targetMs, now) {
    var buckets = {};

    records.forEach(function (record) {
      var date = record.date;
      // Keyed by the profile's stable id, not its display name: nothing stops
      // two profiles being called the same thing, and keying by name merged
      // them into one row with doubled hours against a single target.
      var monthKey = record.person.id + '|' +
        date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');

      if (!buckets[monthKey]) {
        buckets[monthKey] = {
          person: record.person.name,
          year: date.getFullYear(),
          month: date.getMonth(),
          daysWorked: 0,
          workMs: 0,
          meetingMs: 0,
          creditedMs: 0,
          breakMs: 0,
          lunchMs: 0
        };
      }

      var bucket = buckets[monthKey];
      var s = record.summary;
      if (s.creditedMs > 0) bucket.daysWorked++;
      bucket.workMs += s.workMs;
      bucket.meetingMs += s.meetingMs;
      bucket.creditedMs += s.creditedMs;
      bucket.breakMs += s.breakMs;
      bucket.lunchMs += s.lunchMs;
    });

    // Sorted for the reader (person, then month), not by the internal id key.
    var rows = Object.keys(buckets).map(function (key) {
      return buckets[key];
    }).sort(function (a, b) {
      if (a.person !== b.person) return a.person < b.person ? -1 : 1;
      return (a.year - b.year) || (a.month - b.month);
    }).map(function (b) {
      var expectedDays = countWeekdays(b.year, b.month, now);
      var expectedMs = expectedDays * targetMs;

      return [
        b.person,
        new Date(b.year, b.month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
        b.daysWorked,
        hours(b.workMs),
        hours(b.meetingMs),
        hours(b.creditedMs),
        hours(expectedMs),
        hours(b.creditedMs - expectedMs),
        b.daysWorked ? hours(b.creditedMs / b.daysWorked) : 0,
        minutes(b.breakMs),
        minutes(b.lunchMs)
      ];
    });

    return {
      name: 'Monthly summary',
      columns: [
        { header: 'Person', width: 18, type: 'text' },
        { header: 'Month', width: 16, type: 'text' },
        { header: 'Days worked', width: 13, type: 'int' },
        { header: 'Work (h)', width: 10, type: 'number' },
        { header: 'Meetings (h)', width: 13, type: 'number' },
        { header: 'Counted (h)', width: 12, type: 'number' },
        { header: 'Expected (h)', width: 13, type: 'number' },
        { header: 'Balance (h)', width: 12, type: 'number' },
        { header: 'Avg per day (h)', width: 16, type: 'number' },
        { header: 'Breaks (min)', width: 13, type: 'int' },
        { header: 'Lunch (min)', width: 12, type: 'int' }
      ],
      rows: rows
    };
  }

  /**
   * Weekdays in a month that have actually happened.
   *
   * Counts nothing in a month still to come and stops at today in the month in
   * progress - the same rule the calendar screen applies, which charges no
   * target for a future day. Without the future case, a stray record dated
   * next December billed a full month of expected hours against one logged one.
   */
  function countWeekdays(year, month, now) {
    var total = new Date(year, month + 1, 0).getDate();
    var today = new Date(now);
    var thisMonth = today.getFullYear() * 12 + today.getMonth();
    var thatMonth = year * 12 + month;

    if (thatMonth > thisMonth) return 0;
    var limit = thatMonth === thisMonth ? today.getDate() : total;

    var count = 0;
    for (var day = 1; day <= limit; day++) {
      var dow = new Date(year, month, day).getDay();
      if (dow !== 0 && dow !== 6) count++;
    }
    return count;
  }

  /** Build the workbook as a Blob ready to download. */
  function buildWorkbook(now) {
    var at = now == null ? Date.now() : now;
    var targetMs = Store.settings().dailyTargetMinutes * 60000;
    var records = collect(at);

    return Xlsx.build([
      dailySheet(records, targetMs),
      timelineSheet(records),
      summarySheet(records, targetMs, at)
    ], new Date(at));
  }

  function suggestedFilename(now) {
    return 'track8-attendance-' + TL.dateKeyOf(now == null ? Date.now() : now) + '.xlsx';
  }

  global.T8Report = {
    buildWorkbook: buildWorkbook,
    suggestedFilename: suggestedFilename,
    collect: collect,
    countWeekdays: countWeekdays
  };
})(typeof window !== 'undefined' ? window : globalThis);
