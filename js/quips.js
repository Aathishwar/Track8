/**
 * Track8 - reminder quips
 *
 * Picks the one-liner that leads a reminder. English by default; full Tanglish
 * once someone has found the easter egg - five taps on the header logo.
 *
 * The quip is a prefix and never a replacement: notify.js appends the minutes
 * and the action underneath, because the person reading this on a lock screen
 * needs to learn how far over they are, not just be entertained.
 *
 * Lines live in js/quips-english.js and js/quips-tanglish.js so either pack can
 * grow to any size, or be replaced by a generated batch, without this file
 * changing. Nothing here waits on a network call - a reminder is due on a
 * sleeping phone that may be offline, so the packs are local tables and always
 * will be.
 */
(function (global) {
  'use strict';

  // Which line was used last, per kind, so the same one never lands twice in a
  // row on a repeat nag - which is exactly when it would be noticed.
  var lastPick = {};

  function enabled() {
    try {
      return global.T8Store.settings().tanglishReminders === true;
    } catch (e) {
      return false;
    }
  }

  function personName() {
    try {
      var person = global.T8Store.activePerson();
      var name = person && person.name ? String(person.name).trim() : '';
      // 'Me' is the default profile name, not something anyone chose to be
      // called, and being nagged by it reads as a bug.
      if (!name || name === 'Me') return '';
      return name.split(' ')[0];
    } catch (e) {
      return '';
    }
  }

  function fill(line, overMinutes, name) {
    var text = line.replace(/\{n\}/g, String(Math.max(0, overMinutes)));
    if (name) return text.replace(/\{name\}/g, name);
    // No name: drop the vocative and the comma it was leading, rather than
    // greeting somebody called "undefined". Dropping a leading "{name}, " also
    // takes the capital with it, so the sentence gets it back.
    text = text.replace(/\{name\},\s*/g, '').replace(/\{name\}/g, 'Boss');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /**
   * A line for `kind` - BREAK, LUNCH, PAUSE, MEETING, STRETCH or OVERTIME -
   * given how many minutes past the allowance the person is.
   *
   * Returns '' if neither pack loaded, which callers treat as "just the facts,
   * then". That is a normal answer, not a failure.
   */
  function forKind(kind, overMinutes) {
    var pack = (enabled() && global.T8QuipsTanglish) || global.T8QuipsEnglish;
    var lines = pack && (pack[kind] || pack.BREAK);
    if (!lines || !lines.length) return '';

    var previous = lastPick[kind];
    var index = Math.floor(Math.random() * lines.length);
    if (lines.length > 1 && index === previous) index = (index + 1) % lines.length;
    lastPick[kind] = index;
    return fill(lines[index], overMinutes, personName());
  }

  global.T8Quips = {
    forKind: forKind,
    enabled: enabled,

    // Exposed for the same reason as the rest of the modules: the pack is
    // verified by driving it, and a line that loses its {name} or keeps a
    // dangling comma is the only way this can be wrong.
    fill: fill
  };
})(typeof window !== 'undefined' ? window : globalThis);
