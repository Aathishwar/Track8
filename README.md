# Track8

A daily attendance tracker built around one number: how much of your 8 hours you have actually worked today.

Start work, join a meeting, take a break, take lunch, end the day. Meetings count towards your 8 hours; breaks and lunch do not. If you forget to end a break the app chases you until you clock back in.

No accounts, no server, no network. Everything is stored on the device it runs on.

---

## Install it on your phone

Reminders only work properly once the app is installed to your home screen. In a browser tab, the phone treats it as a web page it can freeze at any moment.

**Android (Chrome)** — open the site, tap the ⋮ menu, choose **Install app** (or **Add to home screen**). Open Track8 from the new icon from then on.

**iPhone (Safari)** — open the site, tap Share, choose **Add to Home Screen**. Notifications need iOS 16.4 or newer *and* the home-screen install; Safari tabs cannot show them at all.

Then open the app, tap the bell in the top bar, and allow notifications.

### One more step on Android

Phone makers add their own battery savers on top of Android, and those will silence the app while the screen is off. Find your browser (or Track8, if it was installed as its own app) in:

- **Samsung** — Settings › Battery › Background usage limits › make sure it is *not* in "Sleeping apps", and set it to **Unrestricted**
- **Xiaomi / Redmi / POCO** — Settings › Apps › Manage apps › Track8 › Battery saver › **No restrictions**, and turn **Autostart** on
- **OnePlus / Oppo / Realme / vivo** — Settings › Battery › Battery optimisation › Track8 › **Don't optimise**
- **Stock Android / Pixel / Motorola** — Settings › Apps › Track8 › Battery › **Unrestricted**

Skip this and you still get the pinned notification and a reminder the moment you open the app — you just lose the nudges while the phone is asleep.

---

## How the reminders work

You asked for: start a break, put the phone away, and be told at 15 minutes and every 5 minutes after that if you forget to come back. Lunch the same, starting at 30 minutes.

No web app can guarantee waking a sleeping phone without a push server, so this is delivered in three layers. The weakest one failing never costs you the reminder entirely.

**1. Pinned notification — always works.** The moment a break starts, a notification appears and stays in your notification shade for the whole break. It carries an **End break** button, so you can clock back in from the lock screen without opening the app.

**2. Live nudges — usually works on Android.** At 15 minutes, then every 5, with sound and vibration. This needs the app's timer to survive the screen going off, which Android only allows for pages playing audio — so the app plays a silent track for the length of the break. You can turn this off in Settings if you would rather save the battery. iPhones suspend it regardless.

**3. Catch-up — cannot fail.** Whenever you open the app it works out the true elapsed time from timestamps and tells you immediately: *"You have been on break for 34 minutes."*

If layer 2 turns out to be unreliable on your phone, the fix is a small push server. The service worker already has the `push` handler wired for it, so that is an addition rather than a rewrite.

---

## Why the numbers stay right

Time is stored as a list of moments, not as a running count:

```
09:02  started work
12:31  started lunch
13:14  back to work
18:05  ended day
```

Totals are worked out by subtracting timestamps whenever you look. Nothing needs to be awake and counting. That means your hours survive the phone locking, the tab closing, the browser throttling background timers, and the laptop being suspended — all of which silently lost time in counter-based versions.

It also means a day can be corrected after the fact. Forgot to clock in? Open the day and type the real hours in.

**Left a shift running overnight?** The app will not invent the hours. It flags the day and asks you to set the real numbers. If you are genuinely still working when midnight passes and the app is open, it closes the day at midnight and carries your state into the new one.

---

## Meetings

A meeting is work, so its time counts towards your 8 hours — but it is tracked on its own so you can see how much of the week went to calls rather than to your own work.

While you are working, **Meeting** starts one and **Meeting over, back to work** ends it.

**A meeting can also land after you have already ended the day.** That is what the blue **Log a meeting** button on a closed day is for: the call gets added to that same day, and the day closes itself again when the meeting finishes. The hours between clocking off and the call starting stay uncounted — only the meeting itself is added.

Changed your mind entirely and want to carry on working? **Reopen day** puts you back on the clock. It counts from the moment you press it, not from when you clocked off, so an evening of doing nothing never turns into logged hours.

Colours are consistent everywhere — the status pill, the progress ring, the week chart and the day timeline all agree:

| | |
|---|---|
| 🟢 Green | Work |
| 🔵 Blue | Meetings |
| 🟠 Amber | Short breaks |
| 🟣 Violet | Lunch |
| ⚫ Slate | Paused |

---

## What is in the app

**Timer** — circular progress against your daily target, live status, and separate buttons for meeting, short break, lunch, pause and end day. Pause is its own thing: it stops the clock without being recorded as a break.

**Week** — a stacked bar per day. Work and meetings sit at the bottom, which is why the dashed goal line reads directly against them; breaks and lunch stack above the line because they do not count. Below that: logged vs expected and a running balance. Expected only counts weekdays that have already happened, so Wednesday is not scored against a full five-day week.

**Calendar** — a month at a glance, colour-coded. Tap any day for its full breakdown and timeline, and to correct it. Days that have not happened yet are not tappable.

**Profiles** — several people can track on the same device, each with their own history. Add, rename and delete from Settings.

**Settings** — reminder timings, daily target, profile management, Excel export, backup and restore.

---

## Getting your hours out

Settings › **Export to Excel** downloads a real `.xlsx` with three sheets:

- **Daily log** — one row per day: date, clock in and out, work, meetings, counted total, target, balance, breaks, lunch, status and your note. This is the sheet you would send to someone.
- **Timeline** — one row per activity span. The audit trail behind the daily log.
- **Monthly summary** — per month: days worked, hours, expected, balance, average per day.

Dates are real dates and hours are real numbers, so you can sort, filter, sum and pivot without cleaning anything up. Headers are frozen and filters are already on.

Settings › **Backup file** writes a `.json` instead. That is the boring one, and the important one: **it is the only file that can be restored.** The spreadsheet is for reading and sharing; it cannot be read back into the app. Keep a backup somewhere safe.

---

## Your data

Stored in this browser's local storage under `track8_attendance_app_v2`. It never leaves the device.

That also means **clearing your browser data deletes it**, and hours logged on your phone will not appear on your laptop. Take a backup now and then.

Data from the earlier version is migrated automatically the first time you open this one. Those days are marked "imported" because the original only kept totals, not the individual clock-ins, so the timeline shown for them is a reconstruction.

---

## Publishing it

Plain HTML, CSS and JavaScript. No build step, no dependencies, no bundler.

```
git init
git add .
git commit -m "Track8 attendance tracker"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the repository: **Settings › Pages › Source: deploy from branch › main / (root)**.

It must be served over HTTPS (GitHub Pages is) — service workers and notifications are disabled on plain HTTP and on `file://` paths. Opening `index.html` by double-clicking works for a quick look, but with no install and no reminders.

To try it locally with everything working:

```
python -m http.server 8123
```

then open `http://127.0.0.1:8123/` — `127.0.0.1` counts as a secure origin.

After you publish an update, the app may need one extra refresh to pick it up.

---

## Files

```
index.html               markup and modals
styles.css               design system, mobile-first, safe-area aware
manifest.webmanifest     home-screen install metadata
sw.js                    offline cache + all notification delivery
icons/                   generated app icons
js/timeline.js           event log to durations. Pure, no DOM, no storage
js/store.js              persisted shape, validation, v1 migration
js/xlsx.js               .xlsx writer: store-only ZIP + CRC32 + SpreadsheetML
js/report.js             the three worksheets, built from the event logs
js/notify.js             the three reminder layers
js/ui.js                 all DOM rendering
js/app.js                state machine, tick loop, event handlers
```

`js/timeline.js` is the piece worth reading first — everything else depends on it being right.
