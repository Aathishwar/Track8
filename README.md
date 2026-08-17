# Track8

A daily attendance tracker built around one number: how much of your 8 hours you have actually worked today.

Start work, join a meeting, take a break, take lunch, end the day. Meetings count towards your 8 hours; breaks and lunch do not. If you forget to end a break the app chases you until you clock back in.

Sign in with your email and a 6-digit code — no password, no sign-up form. Your hours are then kept both on the device and on your own server, so a new phone or a cleared browser gets them back.

The app itself never waits for the network. Every tap is written locally and returns immediately; syncing happens quietly in the background and is simply skipped when there is nothing to sync to. Offline it behaves exactly as it does online.

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

Nothing running on the phone can be relied on to wake a sleeping phone, so this is delivered in layers. The weakest one failing never costs you the reminder entirely.

**0. Sent from the server — the reliable one.** When the app is deployed with the push server, your break deadline is held server-side and the reminder is sent to your phone at the right moment. Nothing of the app's has to still be running, so no battery manager can interfere. This is the layer that actually solves the problem; the three below it are what you get without a server.

**1. Pinned notification — always works.** The moment a break starts, a notification appears and stays in your notification shade for the whole break. It states the time you are due back and carries an **End break** button.

**2. Live nudges — usually works on Android.** At 15 minutes, then every 5, with sound and vibration. This needs the app's timer to survive the screen going off, which Android only allows for pages playing audio — so the app plays a silent track for the length of the break. You can turn this off in Settings if you would rather save the battery. iPhones suspend it regardless.

**3. Catch-up — cannot fail.** Whenever you open the app it works out the true elapsed time from timestamps and tells you immediately: *"You have been on break for 34 minutes."*

The app notices when your phone kills layer 2 and says so, rather than letting a late reminder look like an unreliable app. With layer 0 running, none of that matters and Settings says so.

---

## Breaks and lunch, straight from the notification

On Android you never have to open the app to take a break or come back from one. The pinned notification carries the buttons and the tap is handled in the background — no window appears, nothing to unlock, nothing to wait for.

| What the shade shows | What it offers |
|---|---|
| ⏱️ On the clock | **☕ Break** · **🍱 Lunch** |
| ☕ Break · back by 14:35 | **End break** |
| 🍱 Lunch · back by 13:15 | **End lunch** |
| 👥 In a meeting | **☕ Break** · **🍱 Lunch** |
| ⏸️ Paused | **▶ Back on the clock** |

The card rewrites itself under your thumb, so it always says where you actually are.

**Pause, ending the day and logging a meeting open the app on purpose.** A meeting needs a length, and a notification has nowhere to ask for one. Ending the day is the one thing you should not be able to do by mis-tapping something next to it — that used to sit beside "Back on the clock" and a miss closed the whole day. From the lock screen it is still one press of the media card's stop button.

**Your hours stay exact even though the app was closed.** The tap is recorded with the moment it happened, and written into your day whenever you next open Track8. A break you ended at 14:32 is a break that ended at 14:32, whether the app caught up at 14:33 or at six in the evening. The whole app works by subtracting timestamps rather than counting seconds, which is what makes that safe.

**One caveat, and it is Android-only.** iPhones ignore notification buttons entirely — iOS web push shows the title and body and nothing else, so on an iPhone tapping the notification opens the app and you clock back in from there.

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

**Settings** — collapsible groups, each header showing its own current values so the common question is answered without opening anything: reminders, daily target, profile, account and sync, data export, install.

---

## Getting your hours out

Settings › **Export to Excel** downloads a real `.xlsx` with three sheets:

- **Daily log** — one row per day: date, clock in and out, work, meetings, counted total, target, balance, breaks, lunch, status and your note. This is the sheet you would send to someone.
- **Timeline** — one row per activity span. The audit trail behind the daily log.
- **Monthly summary** — per month: days worked, hours, expected, balance, average per day.

Dates are real dates and hours are real numbers, so you can sort, filter, sum and pivot without cleaning anything up. Headers are frozen and filters are already on.

Settings › **Backup file** writes a `.json` instead. That is the boring one, and the important one: **it is the only file that can be restored.** The spreadsheet is for reading and sharing; it cannot be read back into the app. Keep a backup somewhere safe.

---

## Accounts and sync

Signing in is an email address and a 6-digit code. There is no password to forget and no sign-up step — an address becomes an account the first time it proves it can receive a code.

**Your name is a label, never a credential.** It fills in your profile, and only when that profile has no name yet. Typing it differently next time cannot lock you out, and cannot rename what you have set inside the app.

**Already been using the app?** Everything already on the device is uploaded the first time you sign in. Nothing starts fresh.

**Changing your email** — Settings › Account & sync › Change email. The code goes to the *new* address, because that is the thing being proved; your session proves the rest. Every signed-in device stays signed in, and your hours do not move.

**Offline** the app is unchanged. Days are written locally and returned immediately, and sync catches up when you are back. Where two devices edited the same day while both were offline, the newer edit wins and the older one is kept rather than thrown away.

**What is on the server:** your day event logs, profile names and settings. Each account can only ever read its own — enforced both by every query being scoped to the signed-in account and, behind that, by Postgres row-level security, so a query that forgot its filter returns nothing rather than everything.

---

## Your data

The working copy lives in this browser's local storage under `track8_attendance_app_v2`, and the durable copy lives in your database once you are signed in.

Signed out, or deployed without a server, it is local only — which means **clearing your browser data deletes it**, and hours logged on your phone will not appear on your laptop. Take a backup now and then.

Data from the earlier version is migrated automatically the first time you open this one. Those days are marked "imported" because the original only kept totals, not the individual clock-ins, so the timeline shown for them is a reconstruction.

---

## Publishing it

The app is plain HTML, CSS and JavaScript — no build step, no bundler, no framework. It can be deployed two ways.

### Static host, no server

Copy the folder to GitHub Pages or any static host. You get the tracker, offline support and the on-device reminder layers. You do not get accounts, sync, or server-sent reminders — the app detects their absence and quietly runs local-only.

**HTTPS is required.** Service workers and notifications are disabled on plain HTTP and on `file://` paths, and without HTTPS Android offers only a bookmark shortcut rather than a real install — which is why the icon looks wrong and the app opens in a browser tab with a URL bar.

### With the server — accounts, sync, reliable reminders

`server/` is a small Express app that serves the site *and* runs the sync and push endpoints. Same origin on purpose: a push subscription belongs to the origin that registered the service worker.

`render.yaml` describes the deployment. In short:

1. **Neon** → create a Postgres project, copy the *pooled* connection string.
2. **Brevo** → verify a sender address, create an API key. The HTTP API, not SMTP: Render blocks outbound ports 25, 465 and 587.
3. `cd server && npm install && npm run keys` once, for the push key pair.
4. Set `DATABASE_URL`, `BREVO_API_KEY`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in Render's Environment tab.
5. **Point a cron at `/healthz` every 10 minutes.** Free-tier Render idles a service after ~15 minutes, and an idle server cannot send a reminder on time.

`/healthz` reports which parts are live: `{"sync":true,"mail":true,"push":true}`.

See `server/README.md` for the detail, including every failure mode and what the app does in each.

### Locally

```
cd server && npm install && npm start     # http://localhost:3000
```

Copy `server/.env.example` to `server/.env` and fill it in. With `BREVO_API_KEY` left empty the sign-in code is printed to the server console instead of emailed, which is enough to work on the whole flow without sending mail.

Without the server, `python -m http.server 8123` still works for the static app — `127.0.0.1` counts as a secure origin.

After you publish an update, the app may need one extra refresh to pick it up.

On Android, an installed Track8 that is only backgrounded can keep running the old background worker, so a notification may still show yesterday's buttons after you have refreshed the app itself. Swipe Track8 fully out of recents, reopen it, and start and end one break to redraw the pinned card. Android's **Clear cache** is safe if it is still stuck; **Clear data** or **Clear storage** is not — that erases your hours. Take a backup first.

---

## Files

```
index.html               markup, modals, sign-in screen
styles.css               design system, mobile-first, safe-area aware
manifest.webmanifest     home-screen install metadata
sw.js                    offline cache, notification delivery, push handler,
                         and break/lunch handled without opening the app
icons/                   generated app icons
render.yaml              deployment blueprint

js/timeline.js           event log to durations. Pure, no DOM, no storage
js/store.js              persisted shape, validation, v1 migration
js/xlsx.js               .xlsx writer: store-only ZIP + CRC32 + SpreadsheetML
js/report.js             the three worksheets, built from the event logs
js/handoff.js            the box the page and the service worker share
js/shift-card.js         what the pinned notification says and offers
js/notify.js             the on-device reminder layers
js/push.js               subscribes this device to server-sent reminders
js/sync.js               account, sign-in, and background sync
js/ui.js                 all DOM rendering
js/app.js                state machine, tick loop, event handlers

server/index.js          serves the app, routes the API
server/db.js             schema, connection pool, per-account transactions
server/auth.js           emailed codes, sessions, changing your address
server/sync.js           the one delta-exchange endpoint
server/reminders.js      pending reminders and the send scheduler
server/mail.js           Brevo HTTP API
```

`js/timeline.js` is the piece worth reading first — everything else depends on it being right. `server/db.js` is second, because everything about keeping one person's hours away from another's is decided there.
