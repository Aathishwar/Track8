/**
 * Track8 - reminder lines, English (data only)
 *
 * The default pack. Short and dry: a reminder is read on a lock screen in about
 * a second, and the facts follow it in the same notification, so a line that
 * runs past one breath is a line that gets truncated.
 *
 * House rules for anything added here:
 *   - Under 60 characters. The kind and the minutes are printed beside it.
 *   - {n} is minutes past the allowance, {name} the person's first name. Both
 *     are optional; lines without them are picked just as often.
 *   - Write it as "{name}, ..." with the comma so it drops cleanly.
 *   - Teasing, never insulting. No emoji: the title already carries one.
 *
 * Kinds: BREAK, LUNCH, PAUSE, MEETING, STRETCH (too long at the desk),
 * OVERTIME (past the daily target).
 */
(function (global) {
  'use strict';

  global.T8QuipsEnglish = {
    BREAK: [
      'That coffee went cold {n} min ago.',
      'Your chair filed a missing person report.',
      '{name}, the break is winning.',
      'Break: {n} min over. Desk: unimpressed.',
      'Still brewing? It has been {n} min.',
      'The mug is empty. The clock is not.',
      '{name}, one more sip and it is a lunch.',
      'This break has outlasted three meetings.'
    ],

    LUNCH: [
      'Plate empty. Clock waiting.',
      'That was lunch and a nap. {n} min over.',
      '{name}, food coma clocking out now?',
      'Lunch is {n} min past its own deadline.',
      'The kitchen is closed. The laptop is not.',
      '{name}, dessert was not on the timesheet.',
      'Second helpings, second hour.',
      'Good meal. Bad maths: {n} min over.'
    ],

    PAUSE: [
      'Still paused. Nothing is counting.',
      'Paused {n} min. The clock is not paying.',
      '{name}, pause is not a plan.',
      'This pause has a pause of its own.',
      'Frozen for {n} min. Thaw?',
      '{name}, the day is on hold. On purpose?',
      'Paused since a while ago. Just checking.',
      'Nothing is accruing. Nothing at all.'
    ],

    MEETING: [
      '{n} min in. Someone say "circle back".',
      'This one could have been an email.',
      '{name}, blink twice if you are trapped.',
      'Meeting at {n} min and still going.',
      'Agenda item: leaving.',
      '{name}, {n} min. Your desk misses you.',
      'Long meeting. It does count, at least.',
      'Still talking. Still credited. Still long.'
    ],

    STRETCH: [
      '{n} min straight. Stand up.',
      'Your spine called. Take five.',
      '{name}, no break in {n} min. Move.',
      'Straight through since forever. Blink.',
      'Legs exist. Use them for a minute.',
      '{name}, a break now beats a crash later.',
      'Screen 1, human 0. Take a break.',
      'Hydrate. Then come back and win.'
    ],

    OVERTIME: [
      'Eight hours done. Go home.',
      'Target hit. This is bonus time now.',
      '{name}, {n} min past the goal.',
      'The day is paid for. End it?',
      'Overtime: {n} min and counting.',
      '{name}, tomorrow also has hours in it.',
      'Goal met. The rest is a gift.',
      'Still on the clock {n} min past 8h.'
    ]
  };
})(typeof window !== 'undefined' ? window : globalThis);
