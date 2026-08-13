# Track8 — notes for Claude Code

Mobile-first PWA that tracks a daily 8-hour work target, with break/lunch reminders that
survive the phone's screen being off. Single user, single device, no server.

**Vanilla HTML/CSS/JS. No build step, no bundler, no dependencies, no framework.** Deployed
by copying the folder to any static host (GitHub Pages). Do not introduce npm, TypeScript,
a bundler, or a runtime library without being asked — "no build step" is a product
requirement, not an accident.

## Run it

```
python -m http.server 8123      # then http://127.0.0.1:8123/
```

Must be served over http(s). Service workers and notifications are disabled on `file://`,
so double-clicking `index.html` gives you a degraded app with no reminders and no install.
`127.0.0.1` counts as a secure origin, so localhost is enough.

There is no test runner. Behaviour is verified by driving the real app in a browser and
asserting against `window.T8Timeline` / `window.T8Store` / `window.T8Report`, which are all
exposed on `window` for exactly that reason.

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
| `js/notify.js` | The three reminder layers, keep-alive audio, service-worker notification delivery. |
| `js/ui.js` | All DOM writing. Nothing else in the codebase writes to the DOM. |
| `js/app.js` | State machine, tick loop, event handlers. Deliberately thin. |
| `sw.js` | Offline shell cache + **all** notification posting and notification-action routing. |

Load order in `index.html` matters — each module reads its dependencies off `window` at
definition time.

## Rules that are easy to break

**`ENDED` is not terminal.** A meeting can be logged after the day was ended (the evening
call). The day reopens for it and re-closes afterwards, so a single day may contain several
`ENDED` events. `segmentsOf()` *skips* `ENDED` spans but keeps walking past them — the
off-the-clock gap must credit zero time while the meeting after it still accrues.

**`creditedMs = workMs + meetingMs`** is the headline number: the ring, the percentage, the
calendar dots, the week bars and every balance use it. `workMs` alone is desk work only.
Breaks, lunch and paused time are never credited.

**Never `new Date('2026-08-13')`.** That parses as UTC and shifts the day for anyone west of
Greenwich. Use `TL.dateFromKey()`, which builds a local-midnight `Date`.

**Never `dateFromKey(key) + DAY_MS` either.** A local day is 23 or 25 hours long on a
daylight-saving changeover, so adding a fixed 24h lands an hour off — and on a fall-back day
it resolves to 23:00 of the *same* date. That made `splitAtMidnight` hand back a "next" day
identical to the one it had just closed, so the caller overwrote the real log and then looped
forever. Use `TL.nextMidnightOf(key)`, which does calendar arithmetic. India has no DST so
this is invisible on the author's machine; verify timezone logic with
`$env:TZ='America/New_York'; node …` against `js/timeline.js` directly.

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

**Storage is written on state transitions only, never per second.** The tick path touches
text nodes and one stroke offset. If you find yourself calling `Store.save()` from a render
function, that is a battery bug on a phone in a pocket.

**Notifications must go through `swRegistration.showNotification()`.** `new Notification()`
throws `Illegal constructor` on Android Chrome — the target device. The constructor in
`notify.js` is a desktop fallback only.

**A stale open day is clamped to its own midnight.** A shift someone forgot to end last
Tuesday must not report the hours since. Three places apply this clamp and must agree, or
the screen, the correction form and the spreadsheet will each show a different number:
`renderOpenShiftBanner()` and `fillEditForm()` in `ui.js` (both via `clampToDay()`), and
`collect()` in `report.js`. The edit form especially — an unclamped prefill of "74" hours
fails the field's `max="24"` and leaves Save silently doing nothing.

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

**`BAR_TRACK_PX` / `BAR_BASE_PX` in `ui.js` mirror `--bar-track-height` and the day-label
row plus flex gap in `styles.css`.** The week goal line is positioned in pixels against that
scale. Change one, change the other.

**Bump `CACHE` in `sw.js`** when shell files are added or removed, and add new `js/*.js` to
`SHELL`. The fetch handler is network-first with cache fallback, so an update lands on the
next load, but the precache list still has to be right for offline.

**Animate `transform` and `opacity`, nothing else.** Those two are the only properties the
compositor can run without waking the main thread. Anything animating height, width, top,
`filter` or `box-shadow` costs a frame on the mid-range Android this app targets. Two things
in the stylesheet used to break that rule and both were doing real damage: a `drop-shadow`
on `.ring-fill` that re-rasterised on every frame of the once-a-second dashoffset
transition, and `transition: height` on `.bar-seg`, which never even fired because
`renderWeek()` replaces every bar node. `backdrop-filter` is kept only on the header, the
bottom nav and the modal scrim, where there is genuinely content behind the surface — the
cards sit on a flat background, so blurring there cost a full-width GPU pass to produce a
pixel-identical result.

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
`--text-muted` is pinned at a measured 4.6:1 against `--bg-surface`; it is the colour of
most small text in the app, and the previous value measured 3.45:1.

**The `vibrate` option on a notification is not a vibration API.** On Android an installed
web app's notifications go through a system notification channel, and whether that channel
vibrates belongs to the user and the OEM. A reminder can appear, make a sound, and not buzz.
`buzz()` in `notify.js` calls `navigator.vibrate()` as well, which is the path we control —
but only while the page is visible, because Chrome ignores it from a hidden page. Both are
set; neither alone is sufficient. iOS has no vibration API at all, so the settings test
reports what actually happened instead of claiming success.

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
