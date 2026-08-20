# Track8 — notes for Claude Code

Mobile-first PWA that tracks a daily 8-hour work target, with break/lunch reminders that
survive the phone's screen being off. Email-code accounts sync it across devices; the phone
stays the working copy and the app never waits on the network.

**The client is vanilla HTML/CSS/JS: no build step, no bundler, no dependencies, no
framework.** Do not introduce npm, TypeScript, a bundler or a runtime library into `js/`
without being asked — "no build step" is a product requirement, not an accident. The folder
must stay deployable to a plain static host, where it runs local-only.

**`server/` is exempt and separate.** Ordinary modern Node with dependencies, none of which
reach the browser.

## Run it

Static only — tracker, offline, on-device reminders, no accounts:

```
python -m http.server 8123      # then http://127.0.0.1:8123/
```

Everything, including sync and sign-in:

```
cd server && npm install && npm start    # http://localhost:3000
```

Copy `server/.env.example` to `server/.env` first. Leave `BREVO_API_KEY` empty and the
sign-in code is printed to the server console instead of emailed, which is enough to work on
the whole flow without sending mail.

Must be served over http(s). Service workers and notifications are disabled on `file://`,
so double-clicking `index.html` gives you a degraded app with no reminders and no install.
`127.0.0.1` counts as a secure origin, so localhost is enough.

There is no test runner. Behaviour is verified by driving the real app in a browser and
asserting against `window.T8Timeline` / `window.T8Store` / `window.T8Report` / `window.T8Sync`,
which are all exposed on `window` for exactly that reason. The server is verified the same
way: drive the real endpoints against a real database, including a deliberately unscoped
query to prove row-level security is doing something.

## The one invariant that matters

**Durations are derived by subtracting timestamps. They are never accumulated by a counter.**

A day is an ordered event log; each event records the moment a state began:

```js
{ dateKey: '2026-08-13', note: '', events: [
  { t: 1755054000000, s: 'WORKING' },
  { t: 1755065400000, s: 'BREAK'   },
  { t: 1755066720000, s: 'WORKING' }
]}
```

`summarize(day, now)` walks that list and subtracts. Nothing has to be awake and counting.

This is what makes the app correct when the tab is closed, the phone sleeps, the browser
throttles background timers, or the machine is suspended for a week. The previous version
did `workSeconds += delta` on a `setInterval` and silently lost every minute the page was
not running.

If you are ever tempted to add a counter that increments on a tick, don't. The bug it
reintroduces is invisible in testing and total in real use.

## Files

| File | Responsibility |
|---|---|
| `js/timeline.js` | Event log → durations. **Pure**: no DOM, no storage, no `Date.now()` except via the `now` argument. Read this first. |
| `js/store.js` | The persisted shape. The only module that touches `localStorage`. Validation, repair, v1→v2 migration. |
| `js/xlsx.js` | `.xlsx` writer: store-only ZIP + CRC32 + SpreadsheetML. Generic; knows nothing about attendance. |
| `js/report.js` | Builds the three worksheets from the event logs. |
| `js/handoff.js` | The IndexedDB box the page and the worker share: taps the worker took, and a snapshot of the day for it to read. **Loaded in both scopes** — no DOM, no `localStorage`. |
| `js/shift-card.js` | What the pinned notification says and which buttons it carries. **Loaded in both scopes**, because the worker redraws that same notification. |
| `js/notify.js` | The on-device reminder layers, keep-alive audio, service-worker notification delivery. |
| `js/push.js` | Subscribes this device to server-sent reminders. Fails soft on every path. |
| `js/sync.js` | Account state, sign-in, and the background delta sync. Fails soft on every path. |
| `js/ui.js` | All DOM writing. Nothing else in the codebase writes to the DOM. |
| `js/app.js` | State machine, tick loop, event handlers. Deliberately thin. |
| `sw.js` | Offline shell cache, **all** notification posting, action routing, the push handler, and settling a break or lunch on its own with the app closed. |
| `server/db.js` | Schema, pool, and `withAccount()` — where isolation is decided. Read it before touching a query. |
| `server/auth.js` | Emailed codes, sessions, changing an address. |
| `server/sync.js` | The one delta-exchange endpoint. |
| `server/reminders.js` | Pending server-sent reminders and the scheduler. |
| `server/mail.js` | Brevo HTTP API. Not SMTP — Render blocks those ports. |

Load order in `index.html` matters — each module reads its dependencies off `window` at
definition time. `js/handoff.js` and `js/shift-card.js` therefore come before `js/notify.js`,
which reads `T8Shift` and `T8Handoff` as it defines itself.

Those two are also pulled into `sw.js` with `importScripts`, so they run in a worker as well
as a page: no DOM, no `localStorage`, no `T8Store`, and they close over
`typeof window !== 'undefined' ? window : self` rather than assuming `window` exists.

## Rules that are easy to break

**`ENDED` is not terminal.** A meeting can be logged after the day was ended (the evening
call). The day reopens for it and re-closes afterwards, so a single day may contain several
`ENDED` events. `segmentsOf()` *skips* `ENDED` spans but keeps walking past them — the
off-the-clock gap must credit zero time while the meeting after it still accrues.

**`creditedMs = workMs + meetingMs`** is the headline number: the ring, the percentage, the
calendar dots, the week bars and every balance use it. `workMs` alone is desk work only.
Breaks, lunch and paused time are never credited.

**The finish time is projected from `now`, never from the start clock.**
`TL.projectFinish(summary, now, opts)`. `firstIn + 8h` is wrong the moment anybody takes a
break: rest is never credited, so a day that started at 09:00 with an hour of it in the log
finishes at 18:00, not 17:00. Projecting `now + (target - creditedMs)` gets that for free —
every minute spent resting pushes the answer a minute later, every minute at the desk leaves
it where it is, and nothing has to be awake and counting for it to stay true.

`restToComeMs` is the one prediction in it: the lunch this day has not taken yet, capped at
the work that is left. Without it the finish time jumps half an hour later exactly when
someone is looking at it — as they walk to lunch — and back again when they return. With it,
the minutes of that lunch spend padding that was already on screen and the figure holds
still: 17:30 before lunch, 17:30 during it, 17:30 after. Verified at each step. Only lunch is
padded, because it happens once and its length is configured (`lunchAlertMinutes`); how many
short breaks are left in a day is a guess, so none are added.

`finishAt` is `null` — not a clock time — whenever a projection would be fiction: the day has
not started, it is closed, or the target is already met. Callers fall back rather than
formatting a number. `tooLate` means the projection lands past the 10 pm cut-off, i.e. the
target will not be reached today, and `shortfallMs` is by how much.

**Show the shortfall, not the verdict.** The chip used to read "won't reach 8h today". It said
nothing anyone could act on, it read identically all afternoon, and at twenty characters it
grew the badge row wider than the ring and pushed the percentage off the dial's axis. It now
reads `29m short`, which is the same fact in a third of the width and moves: steady while you
are at the desk, up a minute for every minute spent away from it — the same rule the finish
time follows, because it is the same subtraction. In that state the row's "Out" slot shows the
cut-off (`~10:00 PM`), which is when the day really does stop.

It takes a *summary*, not a day, because it runs on the tick path and there is no reason to
walk the event log twice a second. It is also the one number measured from the **real** clock
while its totals come from the clamped one — `renderTimer` passes `now`, not
`clampToDay(day, now)`. The totals stop at 10 pm; the question "when do I finish?" is still
asked from the actual time.

The answer lands in two places, and it needs both. `#dialChip` carries `out ~18:12` while at
the desk — always visible, no media query removes it — and the `.clock-row` "Out" slot carries
the same time with a tilde until the day ends, when it becomes the real clock-out. That row is
hidden below 620px tall, and during break and lunch below 720px, which is why the chip and not
the row is the primary home.

**The middle slot's label changes with the state; the figure alone is ambiguous.**
`renderLeftSlot()` in `ui.js`. `Left 2h 48m` while the day runs, `Short 1h 20m` once it is
closed — the same number, but under a finished day it is what that day missed, not work still
to come — and `Over 42m` the moment the target is passed, because there is nothing left to
count down and a fixed "Done" would sit there hiding a figure that keeps growing. A closed day
puts the same balance in the chip (`42m over` / `1h 20m short`), deliberately in the muted
colour rather than the amber `over` class: the day is finished and there is nothing to act on.

**Banked overtime is the timer's other question, and it is not the same one.** The finish
time answers "when do I reach 8 hours today". `renderLeaveHint()` answers the one people
actually have on a Thursday — when they can go home given what they have already put in.
`bankedBeforeToday()` measures the surplus exactly as the week view does: everything credited
on this week's earlier days, less one target for each weekday among them, so a weekend shift
is pure surplus and a weekday with nothing on it costs a full day. Today is excluded; it is
the day being spent. Spending the surplus just moves the projected finish earlier by however
much of it there is, **capped at `now`** — banked time can bring an evening forward, it cannot
rewrite an afternoon that has already happened.

It is shown only while there is work still left, and only above `BANKED_FLOOR_MS` (15
minutes): a line that appears for four minutes of surplus is noise, and once the target is met
the balance is the week view's story rather than the timer's.

**That figure is memoised, because seven days summarized every second is not what the tick
path is for.** `bankedCache` keys on today's date, the profile and the target, with a
60-second TTL, and `UI.invalidateBanked()` clears it outright from `saveDayEdit` — correcting
a past day is the one thing that moves the number, and a correction has to land immediately
rather than up to a minute later.

**The hint hides with the clock row, not on its own.** It is listed in both existing height
queries — with `.clock-row` below 620px, and during break and lunch below 720px. That keeps
the tightest viewport the timer is verified at exactly as tall as it was, so the
fits-without-scrolling rule does not need re-deriving for a line that only sometimes appears.

**The badge and the chip stack, they do not sit side by side.** `.target-progress-text` is a
column. In a row the pair grew with whatever the chip had to say and spilled out of the circle,
and `.dial-chip` now carries `max-width: calc(var(--ring-size) * 0.68)` with an ellipsis so no
future wording can do it again. The cap is measured off the ring, not the parent: the parent is
a shrink-to-fit flex item, so a percentage there would resolve against its own content. None of
this costs card height — the whole stack is absolutely positioned inside the ring.

**Never `new Date('2026-08-13')`.** That parses as UTC and shifts the day for anyone west of
Greenwich. Use `TL.dateFromKey()`, which builds a local-midnight `Date`.

**Clock times are pinned to `en-US` 12-hour, not the device locale.** `clockTime()` in
`ui.js` and `timeText()` in `shift-card.js`, which cannot share code because one of them also
runs in the worker. Passing `[]` meant the same shift read `05:40 PM` on one phone and `17:40`
on another purely from its region setting, and two people comparing screens concluded the app
disagreed with itself. `[]` plus `hour12: true` is not the fix either: on a Tamil or Hindi
handset that renders the marker in that script beside otherwise English labels. `'2-digit'`
rather than `'numeric'` because these sit in tabular mono columns, where a one-digit hour
shifts the whole row sideways at ten o'clock.

**`clockFieldValue()` is the exception and must stay 24-hour.** The `value` of an
`<input type="time">` is `HH:MM` by specification whatever the field displays to the user, so
routing it through `clockTime()` hands the element a string it rejects and the field silently
blanks — taking the correction form's start and finish clocks with it.

**Never `dateFromKey(key) + DAY_MS` either.** A local day is 23 or 25 hours long on a
daylight-saving changeover, so adding a fixed 24h lands an hour off — and on a fall-back day
it resolves to 23:00 of the *same* date. That made `splitAtMidnight` hand back a "next" day
identical to the one it had just closed, so the caller overwrote the real log and then looped
forever. Use `TL.nextMidnightOf(key)`, which does calendar arithmetic. India has no DST so
this is invisible on the author's machine; verify timezone logic with
`$env:TZ='America/New_York'; node …` against `js/timeline.js` directly.

**Desk work in the correction form is derived, not typed.** It is the remainder of a shift:
`syncEditForm()` in `ui.js` recomputes it whenever the start clock, the finish clock or the
meeting/break/lunch/**paused** minutes change, and recomputes the *finish* instead when the desk
figure itself is typed. Correcting a start time to an hour earlier used to leave desk work
untouched — the day silently ended an hour early and the user had to do the subtraction by hand.
The two directions must never both fire for one edit, which is why `saveDayEdit` trusts
`editFormProblem` (the last message `syncEditForm` returned) rather than re-deriving at
submit: re-running it there would resolve a contradiction by overwriting whichever field the
user typed last.

**Every uncounted bucket is editable, pauses included.** A pause is the one people tap by
accident, so leaving it out of the form meant the only way to undo one was to delete the day.
`editPausedM` feeds `editRestMs()` like break and lunch, and `rebuildFromTotals` lays a `PAUSED`
block after `LUNCH`.

**A day that has not finished is corrected in a different shape.** "Still on the clock"
(`editStillRunning`) is ticked automatically when the edited day is running, and then: the
finish clock *is* now, so it is disabled; desk work is read-only, because with both ends fixed
it is fully determined; and `rebuildFromTotals` is called with `leaveOpen`, which ends the log
with an open `WORKING` event instead of `ENDED`. Without this, fixing a stray pause on today
demanded a finish time that has not happened and clocked the user out as the price of the
correction.

Five things that shape has to keep doing:

**It resumes into the state the day was actually in.** `opts.openState`, chosen by
`resumeStateFor()` in `app.js` from the pre-edit `TL.currentState(day)`. Hardcoding `WORKING`
meant someone genuinely at lunch, correcting an unrelated field, had their lunch closed out
from under them — the rest of it credited as desk work and the lunch reminder disarmed, with
the shade still offering an "End lunch" button that `pushEvent` would then reject as a
same-state no-op. The one exception is a bucket the user has just zeroed: setting lunch to 0
while on lunch means "I was never at lunch", so that resumes at the desk.

**The offer is today-only.** `fillEditForm` hides the row for any other date, because ticked on
last Tuesday it meant "running until 23:59 that night", which is the 30-hour day
`AUTO_END_HOUR` exists to prevent.

**`saveDayEdit` re-derives desk work from `Date.now()`** rather than reading the field, or the
minutes between opening the sheet and pressing Save are silently lost.

**Unticking re-stamps the finish** (`source === 'toggle'` in `syncEditForm`). The field has
been showing whatever "now" was when the sheet opened — a plausible-looking time that nothing
draws the eye to — so handing it back a minute later without a fresh stamp binned that minute.

**`rebuildFromTotals` appends the trailing open event only if the last block is not already
that state**, since a same-state repeat is exactly what `pushEvent` refuses elsewhere.

**The form models a day as one continuous shift, which an after-hours meeting is not.** A day
that was ended and reopened has an off-the-clock gap the form cannot represent, so saving
flattens it and credits those hours. `editAfterHours` in `ui.js` detects the shape and says so
in the hint line rather than letting the number arrive as a surprise. Fixing it properly means
teaching the form about the gap, not hiding the warning.

**Correcting the active day re-arms everything hanging off it.** `saveDayEdit` calls
`rearmRestingNotifications()` when the edited key is `activeDayKey`. The day it just replaced
may have been mid-break, with a pinned notification, a keep-alive track, a server reminder and a
handoff snapshot all describing a break that no longer exists.

**No event may be timestamped in the future.** `pushEvent` keeps the log monotonic by
bumping a new event to `last.t + 1000`, so a single future-dated event poisons everything
after it: the timer freezes and each later tap collapses into a one-second segment. The
day editor therefore refuses a correction that would finish later than now (`saveDayEdit` in
`app.js`). Anything else that writes events must hold the same line.

**A meeting logged after the day was ended must keep that context across midnight.** The
"is this after hours?" answer comes from `previousState(day) === ENDED`, so when
`splitAtMidnight` carries a `MEETING` into a new day it seeds a leading `ENDED` marker 1ms
before midnight. Without it the carried day looks like a shift that opened with a meeting,
and finishing that meeting clocks the user in for the rest of the night.

**The pinned card and the keep-alive track have different lifetimes.** `syncBackground()` in
`notify.js`. The card is posted for the whole open day, because its buttons are how a break is
*started* without unlocking the phone; the silent track is held only through a break or lunch,
because that is the only stretch layer 2 has to nag through. Tying the card to the track — which
is what the retired lock-screen setting did — left the shade empty all morning and produced the
card only once a break was already running, which is the half nobody needs.

**Storage is written on state transitions only, never per second.** The tick path touches
text nodes and one stroke offset. If you find yourself calling `Store.save()` from a render
function, that is a battery bug on a phone in a pocket.

**Notifications must go through `swRegistration.showNotification()`.** `new Notification()`
throws `Illegal constructor` on Android Chrome — the target device. The constructor in
`notify.js` is a desktop fallback only.

**A day stops accruing at 10 pm.** `TL.AUTO_END_HOUR`. A shift someone forgot to end last
Tuesday must not report the hours since — unclamped it reads 30h, 42h, and every week bar,
calendar total and balance built on it is fiction. Two mechanisms enforce it and they have
to agree:

`TL.autoClose(day, now)` writes a real `ENDED` event **stamped at the cutoff, not at `now`**,
so the total is the same whether the app finds out at 22:01 or the following Friday.
`autoEndForgottenDays()` in `app.js` runs it from `reconcile()` — at most once a minute, and
always on a suspend — walking backwards through every open day, because a phone left alone
over a long weekend has more than one. It runs *before* the midnight split, so an abandoned
shift is closed at 10 pm rather than carried into a new day.

`TL.measuredAt(day, now)` is the read side, for a day that has not been closed yet — another
profile's, or one drawn before the scan ran. **Every reader goes through it**: `renderTimer`,
`renderWeek`, `renderCalendar`, `renderDayDetails`, `renderOpenShiftBanner` and
`fillEditForm` in `ui.js` (all via `clampToDay()`), and `collect()` in `report.js`. Miss one
and that screen alone shows 30h. The edit form especially — an unclamped prefill of "74"
hours fails the field's `max="24"` and leaves Save silently doing nothing.

A day whose own last event is at or after 10 pm keeps its midnight instead, and
`splitAtMidnight` owns it as before: someone still tapping at 22:30 is working late, not
forgetting, and an `ENDED` marker stamped before the last event would only be bumped past it
by `pushEvent` and collapse that stretch into a second.

**An auto-close is a guess, so it keeps asking.** 10 pm is not when anybody actually went
home. The day is flagged `autoEnded`, `Store.findUnsettledDay()` keeps it in the recovery
banner across launches, and the banner's second button becomes "Looks right" — accepting the
guess through `Store.settleDay()`, which is also what Reopen and a correction do. Dismissing
a day that is still *running* is only "later"; its flag is not set and it returns next
launch.

**The timer digits are `aria-hidden`.** They change every second; a live region around them
made screen readers read the clock aloud continuously for the entire shift. The announcement
lives in `#timerAnnouncement` and `announce()` only writes to it when the status or the whole
minute changes.

**Anything that swaps the active day under a running break must re-pin the notification.**
`rearmRestingNotifications()` in `app.js` — called from `init`, `switchPerson` and
`importData`. Miss it and the pinned shade entry with its "End break" action vanishes for the
rest of that break.

**`renderActions()` re-enables every button on every render.** An earlier bug left the Start
button permanently disabled after ending a day and switching profile. Do not disable a
button from anywhere else.

**Anything user-controlled that reaches `innerHTML` goes through `UI.escapeHtml()`** —
profile names and day notes both do, and both travel through export/import.

**The week goal line is placed in CSS, not JavaScript.** `renderWeek()` publishes only
`--goal-ratio`; `styles.css` turns it into a position with
`calc(var(--bar-base-offset) + (100% - var(--bar-chrome)) * var(--goal-ratio))`. It used to
set a pixel offset from `BAR_TRACK_PX` / `BAR_BASE_PX`, constants mirroring the stylesheet,
and that broke twice over once the chart became fluid: the track is no longer 140px, and the
first render happens while `#viewWeek` is still `hidden`, so every rect it could have
measured reads zero and the line stayed at the fallback. If you add or resize anything
between the wrapper's top edge and the bottom of a bar — the value caption, the label row,
either gap — update `--bar-chrome` and `--bar-base-offset` with it.

**Bump `VERSION` in `sw.js`** when shell files are added or removed, when a new `js/*.js` joins
`SHELL`, **and whenever `js/handoff.js` or `js/shift-card.js` changes at all** — those two are
pulled into the worker by version-stamped `importScripts`, so an edit without a bump leaves
phones drawing notifications from the old copy. That has already happened once: commit c5fbc0c
rewrote the card's `ACTIONS` and bumped nothing, so a worker installed before it kept offering
the three-button row this project had just removed. The fetch handler is network-first with cache fallback, so an update lands on the
next load, but the precache list still has to be right for offline.

`VERSION` names the cache *and* is stamped onto the `importScripts` URLs, which is the half
that is easy to miss. The two shared modules are stored beside the worker script in a cache of
their own, not in `CACHE`, so a phone can keep drawing notifications from last week's
`shift-card.js` while the page in front of the user runs this week's — the buttons on screen
then depend on which copy happened to draw that card, which is unfalsifiable from the outside
and cost an afternoon to pin down. Changing the URL forces the fetch instead of trusting the
browser to diff bytes.

**Animate `transform` and `opacity`, nothing else.** Those two are the only properties the
compositor can run without waking the main thread. Anything animating height, width, top,
`filter` or `box-shadow` costs a frame on the mid-range Android this app targets. Two things
in the stylesheet used to break that rule and both were doing real damage: a `drop-shadow`
on `.ring-fill` that re-rasterised on every frame of the once-a-second dashoffset
transition, and `transition: height` on `.bar-seg`, which never even fired because
`renderWeek()` replaces every bar node. `backdrop-filter` is kept only on the header, the
bottom nav and the modal scrim, where content genuinely moves behind the surface — what is
behind a card is the ambient wash on `body::before`, a gradient soft enough that blurring it
returns nearly the same pixels for the cost of a full-width GPU pass on every scrolled frame.

**Entry animations are gated on the data actually changing.** `renderAll()` runs on every
button press. `renderWeek()` and `renderCalendar()` compare against `lastWeekKey` /
`lastCalendarMonth` and only add the `animate` class when the period on screen changed;
without that, starting a break re-plays the whole chart.

**A `background` shorthand after a `background-image` wipes it.** The hatch that marks
break and lunch as uncounted is declared *after* `.swatch-break { background: ... }` for
exactly this reason. Put it earlier and the legend silently loses its pattern while the
bars keep theirs, which is worse than having neither.

**Colour is never the only channel.** Work and meetings are solid, breaks and lunch are
hatched, so "does this count towards my 8 hours?" survives red-green colour blindness.
`--text-muted` is pinned against `--bg-surface` and measured, never guessed: 5.8:1 today,
4.6:1 before the surfaces were re-graded, and 3.45:1 in the version that failed AA. It is
the colour of most small text in the app, so it is the first thing to re-measure whenever a
surface changes.

**The surfaces are tinted, not neutral grey.** `--bg-primary` and friends carry a few
degrees of green so they belong to the emerald the app is built on; `#121212` on `#1e1e1e`
is the palette every framework ships with and it reads as unstyled. Depth comes from three
cheap, static things: the two-hue ambient wash on `body::before`, the `--sheen` gradient
that lights the top edge of every raised surface, and a paired shadow. None of them
animate. The activity colours are also the button colours — lunch is purple on the stat
row, the week bar *and* the Lunch button — so the palette carries meaning rather than
decoration.

**The `vibrate` option on a notification is not a vibration API.** On Android an installed
web app's notifications go through a system notification channel, and whether that channel
vibrates belongs to the user and the OEM. A reminder can appear, make a sound, and not buzz.
`buzz()` in `notify.js` calls `navigator.vibrate()` as well, which is the path we control —
but only while the page is visible, because Chrome ignores it from a hidden page. Both are
set; neither alone is sufficient. iOS has no vibration API at all, so the settings test
reports what actually happened instead of claiming success.

**A notification body has no markup.** No HTML, no markdown, no styling of any kind — the
title is the only line the OS draws in bold. Anything that has to stand out therefore lives
in the title, which is why the pinned notification says "back by 14:35" up there and the nag
carries the elapsed time. Do not add markup to a body expecting it to render; it prints
verbatim.

**Two notification actions is the platform's hard ceiling, and their layout is not ours.**
`Notification.maxActions` is **2** on Chrome for Android and the API *rejects* a longer array
rather than trimming it. Action `icon`s are silently discarded on Android 7 and newer, so an
icon cannot be used to tell two buttons apart. Chrome's `addAction()` goes straight to
`android.app.Notification.Builder`, the same call a native app makes, so this card is drawn by
the same system widget that draws Teams' "Join"/"Later" — there is no cramped web treatment to
escape, and no widths, alignment, gap or even split to set. The widget sizes each button to its
own label and packs them from the left, which is why the pair is roomy on desktop Chrome (it
stretches two actions across the card) and tight enough on a phone to be mis-hit. **The label
text is the only lever there is.**

That lever was tried and it lost. `ACTIONS` in `shift-card.js` carried two labels of
deliberately different lengths, each padded with `U+2007` figure spaces to widen both targets
and separate their centres; on the phone this app is for, the tap meant for Break still landed
on Lunch. **The working card now carries one action.** `BREAK_ONLY` in that file is `true`;
setting it back to `false` restores the padded pair for anyone who wants to retest on a newer
Android. Lunch costs a tap in the app, which is the right way round — starting the wrong kind
of rest without noticing is worse than unlocking the phone.

Pause is not on the card: three buttons left each about a thumb's width and a tap meant for
Break landed on Lunch. End day is not on it either — it sat beside "Back on the clock", so a
miss closed the whole day instead of resuming it. Keep paired labels different lengths, and
never put a destructive action beside a routine one.

**`postMessage` to a window client is not proof of delivery.** Android goes on listing a window
client after it has discarded the page behind it, so the message vanishes and `focus()` reloads
the app at a plain URL with the tap forgotten. That is why "End break" did nothing half an hour
into a break while "Break" worked seconds after using the app — one reached a live page, the
other a ghost. `deliver()` in `sw.js` hands the page a `MessageChannel` port and reads silence
as "no page there", then reloads that window at `?a=…` so the boot path finishes the job. The
page must answer on that port **before** running the action (`listenForServiceWorkerMessages`
in `notify.js`), or a slow save reads as a dead page and costs the user a reload.

**`LAUNCH_ACTIONS` in `app.js` must not toggle.** It used to mean "start a break, or end it if
one is running", which was fine when only a cold launch reached it. It is now also the
worker's fallback when a page did not answer, and a page that answers late has already run the
action — a toggle would undo it. Every entry refuses a state it does not apply to, so arriving
twice is a no-op. `Notify.init()` in `app.js` is handed the same non-toggling functions for
the message path, so both routes to an action behave identically.

**The worker settles break and lunch itself; everything else opens the app.** `IN_PLACE` in
`sw.js`. It cannot write the day — the event log is in the page's `localStorage` — so it
records the tap in `js/handoff.js` with the moment it happened and the app files it on its next
run. Filing it late is lossless *only* because durations are subtracted from timestamps; the
one invariant at the top of this file is what makes the whole feature possible. Pause, end day
and meetings deliberately stay app-only.

**The handoff snapshot stores banked credited time, not credited-time-as-of-now.**
`creditedBeforeMs` excludes the segment that is still open, and `T8Shift.creditedAt(snap, now)`
adds it back at draw time. Storing the live total instead means the open stretch is added a
second time — the first build of this showed 97 minutes when the truth was 79. It is written on
transitions only, never per tick: an IndexedDB write a second is the same battery bug as
`Store.save()` in a render function. Transition-time is sufficient because credited time is
frozen for the whole of a break, which is exactly when the worker reads it. A day that is idle
or `ENDED` has its snapshot **cleared**, or the worker keeps offering to end a break that
finished yesterday.

**A queued tap belongs to the day of its own timestamp, not to today.** `fileHandoffEntry()`
routes by `TL.dateKeyOf(entry.t)`, so a break ended at 23:58 and filed the next morning closes
yesterday's break instead of opening a hole in today. Entries are dropped whether or not they
applied — a tap that does not fit the log never will, and keeping it replays the same refusal
on every launch.

**The header theme button is light ↔ dark only.** "Match phone" is still a choice in
Appearance and `applyTheme` still honours it, but `nextTheme()` does not stop there: a
three-way cycle on a one-tap glance control means the tap meant to darken the screen lands on
the OS setting, which on a phone already set to dark looks like the button did nothing. From
`system` it flips away from whatever the phone is currently showing.

**There is no Media Session lock-screen card, and adding one back is a decision, not a
tidy-up.** The app used to describe its silent keep-alive track to the OS so Android drew it
a music-player card with Break, Lunch, Pause and End day on the transport buttons. It was
removed deliberately. The cost was structural: the card exists only while audio is playing,
so it held audio focus for the entire shift rather than only for breaks — a real battery
drain — and it dragged a settings switch, a five-state status line, generated canvas artwork
and a second set of action semantics along with it. What survives is the pinned notification,
which says what its buttons do and shows on the lock screen anyway.

**Nothing reached from a notification may call `confirm()`.** The page may be behind a locked
screen; a dialog nobody can see blocks the handler and the button does nothing. `actEndDay`
takes an `unattended` flag for exactly that path, and it is safe because ending a day is
recoverable through Reopen.

**`pause` on a media element is delivered asynchronously.** The keep-alive watches for the
phone suspending it by listening for a `pause` it did not ask for. Setting an
"I am stopping this on purpose" flag and clearing it on the line after `pause()` does not
work — the handler runs later, always sees the flag already false, and every normally-ended
break reports itself as killed by the phone. The flag is cleared inside the handler, and it
is only armed when the element was actually playing, or a no-op stop leaves it set and
swallows the next real interruption.

**Nothing can open the browser's notification settings.** There is no web API for it, and
navigating to `chrome://settings/...` from a page is blocked. When permission is `denied`,
`requestPermission()` resolves `denied` without ever prompting — so the "Turn on
notifications" button is hidden in that state and `unblockSteps()` in `ui.js` prints the
exact path for the platform, which differs between an installed PWA and a browser tab.
Recovery is handled by `watchPermission()` in `app.js` (a `permissions.query` `onchange`
listener that heals the card the moment the user comes back), by `onBecameVisible()` for
browsers without that API, and by a visible "Check again" button as the last resort.

**Modals trap focus in `ui.js`, not with `inert`.** `aria-modal="true"` was already claiming
the rest of the page was unreachable while Tab walked straight out of the dialog. The cycle
is hand-rolled because `inert` is missing on the older Android WebViews this targets.
`closeModal` only releases `body.modal-open` once no dialog is left open — the day-details
sheet opens the correction sheet on top of itself.

**The timer view must fit the viewport without scrolling, in every state.**
It is a glance screen; reaching End day should never mean scrolling first. Nothing on it
carries a fixed height — `--ring-size`, `--stack-gap` and `--btn-height` in `:root` are all
`clamp()`d against `vh`, and two media queries drop the lowest-value rows as height runs
out: at 720px the clock-in/out row goes during a break, at 620px the "on the clock" caption
and the stat labels' second line go, and the stat row itself yields to the break banner.
Verified at 0px overflow in all seven states down to 360×560. If you add a row to
`.timer-card`, re-check it at that size — the tallest state is a running break, because it
adds the reminder banner. Copy on that banner is deliberately terse for the same reason.

**Settings is an accordion with one group open at a time.** Each collapsed header quotes its
own current values (`renderSettingsSummaries`), so "what is my break set to?" is answerable
without opening anything. Anything that changes a setting has to refresh those summaries or
the headers start lying.

**No external requests, ever.** No CDN fonts, no analytics, no icons from a URL. The app must
work fully offline once installed. System font stack only.

## Style

The shipped source is ES5-flavoured — `var`, `function`, IIFE modules attaching to `window`.
That is not legacy drift; it keeps the files loadable as plain classic scripts with no build
and no module/CORS complications when opened locally. Match it.

Comments explain *why*, especially where the code looks odd on purpose (the monotonic clamp
in `pushEvent`, skipping `ENDED` in `segmentsOf`, the silent keep-alive track). Do not add
comments that restate the line below them.

## The push server

`server/` is a small Express app that serves the whole site and sends the break
reminders as Web Push. It is the only reminder layer that does not depend on the phone
keeping the page alive, because the push service wakes the service worker directly. See
`server/README.md` for setup and deployment.

**The no-build-step rule covers the client, not this.** `server/` is ordinary modern Node
with dependencies; none of it reaches the browser, and `js/*.js` stays ES5-flavoured with no
bundler.

**Everything about the server is optional at runtime.** `js/push.js` fails soft on every
path — no push support, no network, no keys configured, an older iPhone — and the app falls
back to its three on-device layers. The folder must stay deployable to a plain static host,
so "there is no API here" is a normal state, not an error. A static host answers `/api/…`
with `index.html` and a 200, which is why `fetchJson` insists on a JSON content type before
believing it reached a server.

**The service worker must not cache `/api/`.** The fetch handler caches every same-origin
GET, and once the API shares the origin that would replay a stale "reminder registered" and
serve it from cache while offline as though the server had heard us.

**Only in-flight breaks reach the server.** One record per phone — endpoint, kind, start
time, allowance — deleted when the break ends. No names, no hours, no history. Records are
keyed by the browser's push endpoint, and nothing links two endpoints, which is what keeps
phones independent. Do not add a field to that record without asking what it would leak.

**Re-arm on open, cancel on open.** A record can be lost to a restart, and a break ended
while offline never sends its cancel. `rearmRestingNotifications()` covers both: it re-arms
when something is running and disarms when nothing is.

**Free-tier Render idles after ~15 minutes.** An idle service cannot send a reminder on
time, so the cron ping against `/healthz` is part of the design, not a nicety.

## Accounts and sync

`server/auth.js` signs people in with an emailed six-digit code, `server/sync.js` exchanges
deltas, `js/sync.js` is the client half. Postgres on Neon, mail via the Brevo HTTP API.

**The account id comes from the session cookie and nowhere else.** Never from a request body,
a query string, or a client-supplied profile id. `/api/sync` accepts the client's own profile
ids and resolves them against *this account's* profiles only, so an id belonging to somebody
else does not resolve rather than resolving to their data. This is the single rule that keeps
one person's hours away from another's.

**Neon's default role holds BYPASSRLS.** Enabling and forcing row-level security while
connected as it produces a wall that is not there — verified: an unscoped `select count(*)
from days` returned every account's rows with the policies present and forced. `withAccount()`
therefore does `set local role track8_app`, a role created at boot that cannot bypass
anything. It is transaction-scoped, so it cannot leak across a pooled connection. If you see
`row-level security NOT enforced` at boot, that second wall is missing and the log says so.

**Creating a role does not make you a member of it,** and `set local role` requires
membership. Without the grant every sync returns 500 with "permission denied to set role".

**A policy needs `with check`, not just `using`.** `using` governs which existing rows are
visible to select, update and delete; `with check` governs which rows may be written. A
policy with only `using` silently forbids every insert, which looks like a broken server
rather than a security control.

**Two timestamps per day, deliberately.** `updated_at` is the client's clock and decides
last-write-wins. `synced_at` is server time and is what delta queries use. Merge them and two
phones with clocks a few minutes apart will skip each other's changes, because "everything
newer than my last sync" would be measured against a clock that did not write the row.

**Deletions leave tombstones.** Sync compares differences and an absence is not a difference:
a day that simply vanished would be restored from the server on the next pull, or pushed back
out to the other devices as though it still existed. `deleteDay` writes an empty event list
with `deleted: true`, which reads as "no record" everywhere in the app already.

**Anything that changes a day must stamp it.** `Store.touchDay()`, directly or via `putDay`.
An unstamped change is invisible to sync and never leaves the device.

**The name on the sign-in screen is a label, not a credential.** It is not sent to either
sign-in endpoint and cannot decide whether a code is accepted. It is applied only when the
profile has no name yet, and only after the first sync, so a name already set in the app or
on another device wins — a typo at sign-in must not quietly rename someone everywhere.

**Changing an email sends the code to the new address**, because that is the thing being
proved; the session proves which account is asking. An address that already has an account is
refused rather than merged, checked both before sending and again after the code is consumed,
since it could be claimed during the ten minutes a code is valid.

**The sign-in gate must not appear offline.** Demanding a code that cannot be delivered turns
the app into a locked door in exactly the situation it exists for. `updateSigninGate()`
requires `online`, and the gate returns on the next launch with a connection.

**Everything about the server is optional at runtime.** Every path in `js/sync.js` and
`js/push.js` fails soft. A static host answers `/api/…` with `index.html` and a 200, which is
why the client insists on a JSON content type before believing it reached a server.

**Sign-in codes are hashed with a bare sha256 over six digits.** A million candidates, so
anyone with read access to `login_codes` can recover a live code. The short expiry and the
three-attempt cap are what bound it. If the threat model ever includes database read access,
this needs a server-side pepper.

## Known platform limits

Layer 2 of the reminder (live nagging with the screen off) depends on the page surviving in
the background, which Android only permits for pages playing audio — hence the silent
keep-alive track. Aggressive OEM battery managers and iOS both suspend it anyway. The pinned
notification (layer 1) and the catch-up on reopen (layer 3) always work.

Making the reminder unconditional requires a push server. The `push` handler in `sw.js` is
already wired for it, so that is an addition rather than a rewrite.

`localStorage` is per-browser. Data does not sync between the user's phone and laptop, and
clearing browser data deletes it. The JSON backup is the only restorable export — the Excel
file is for reading and sharing and cannot be read back in.
