# Track8 push server

Serves the app and sends its break reminders as Web Push.

## Why it exists

Every other reminder layer runs on the phone, which is why the strongest of
them can be switched off by the phone. Android only lets a backgrounded page
keep its timers while it is playing audio, and aggressive battery managers
suspend it anyway — so a lunch could run 30 minutes past its limit in silence,
and the reminder would only appear when the app was next opened.

A push does not need anything of ours to be awake. The push service wakes the
service worker, the service worker shows the notification. No silent audio, no
battery exemption, nothing to keep alive.

## What it stores

One record per phone with a break running right now:

```
{ subscription, kind: "BREAK" | "LUNCH", startedAt, firstMinutes, repeatMinutes, dueAt }
```

That is all. No names, no hours, no history — attendance data never leaves the
device. Records are deleted when the break ends, when the reminder has run its
course, or when the push service says the subscription is gone.

Records are keyed by the push endpoint, which the browser generates per device
per browser. Nothing links two endpoints, so two phones running Track8 are
unrelated as far as this server is concerned.

## Setup

```bash
cd server
npm install
npm run keys        # once — prints a VAPID key pair
```

Put the printed values in the environment:

| Variable | Meaning |
|---|---|
| `VAPID_PUBLIC_KEY` | Handed to phones so they can subscribe |
| `VAPID_PRIVATE_KEY` | Signs every push. Never leaves the server |
| `VAPID_SUBJECT` | `mailto:` address push services can contact you at |
| `PORT` | Set by Render automatically |
| `DATA_FILE` | Optional. Where pending reminders are written |

**Generate the keys once and keep them.** Replacing the pair invalidates every
existing subscription, and each phone stays silent until it is next opened.

Run it:

```bash
npm start           # http://localhost:3000
```

## Deploying to Render

`render.yaml` in the project root describes the service. Root directory is
`server`, build is `npm install`, start is `npm start`.

**A cron ping is required, not optional.** Render's free tier idles a service
after roughly 15 minutes without traffic, and an idle service cannot send a
reminder at the right time. Point any cron at `/healthz` every 10 minutes —
cron-job.org and GitHub Actions both do this for free.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Cron ping target; reports push config and pending count |
| `GET` | `/api/vapid-key` | Public key for `pushManager.subscribe()` |
| `POST` | `/api/reminders` | Arm a reminder for one device |
| `DELETE` | `/api/reminders` | Cancel it |

Anything else serves the app.

## Failure behaviour

Every failure mode leaves the app working on its own reminder layers:

- **No keys configured** — the app is still served; `/api/vapid-key` answers
  503 and the client stays on device-side reminders.
- **Server unreachable** — the client fails soft and never blocks a tap.
- **Restart with breaks running** — pending reminders are read back from the
  JSON file. Anything lost is re-armed the next time that phone opens the app.
- **Break ended offline** — the cancel never arrives, so the server keeps
  nagging until its own cap. The client also cancels on open, which closes it.
- **Dead subscription** — 404 and 410 retire it immediately; any other error
  three times in a row retires it too, because not every permanent rejection
  uses those codes.

## A note on style

The client is deliberately vanilla ES5 with no build step, and that rule still
holds — see the project's `CLAUDE.md`. This folder is separate: it is ordinary
modern Node, and its dependencies never reach the browser.
