# mac-lockout

One question: **is Randy permitted to use the MacBook right now?**

```
workout data (iPhone Shortcut) → server decides → root daemon on the Mac enforces
```

The server answers `GET /api/permission`:

1. 23:00–05:00 New York → `{"allowed": false, "reason": "nightly_lockout"}`
2. no satisfactory workout in the last 48 h → `{"allowed": false, "reason": "workout_noncompliance"}`
3. otherwise → `{"allowed": true, "reason": null}`

A satisfactory workout is one session of ≥20 min with ≥5 min above 120 bpm. The rule is unchanged from Workout Gate v2.

The Mac daemon asks the server every 60 s. While the answer is no, whoever is logged in gets logged out, and logged out again after every new login. Nothing shuts the Mac down. An ALLOW is only good for its lease (≤15 min, and never past the moment the answer flips). If the daemon can't get a fresh ALLOW, it denies with `no_recent_allow`.

**Email safeguard.** If the Mac keeps reporting someone logged in while the answer is no, for more than 5 minutes, the server emails you, and again every 30 minutes while it continues.

**Dead man's switch.** Every Mac check-in pings a Healthchecks.io check. If the daemon stops checking in, the check goes down and Healthchecks alerts you. That covers the daemon being deleted or unloaded, but also the Mac being asleep or off.

## Layout

```
server/            Vercel project (root directory = server)
  lib/rules.js     ALL rules and numbers. Pure functions; decide() is the whole decision.
  lib/store.js     Redis keys, auth, event log, email
  api/permission   the Mac asks here (MAC_KEY); you can look too (ADMIN_KEY)
  api/workout      the iPhone Shortcut posts heart-rate readings here (PHONE_KEY)
  api/policy       view/change restrictions (ADMIN_KEY)
  api/admin        dev recovery override, reset workouts, test email (ADMIN_KEY)
  api/events       what happened and why (ADMIN_KEY)
  test/            unit tests + a simulated Mac run (npm test; bash test/simulate-mac.sh)
mac/
  maclockoutd.sh   the root daemon (launchd: com.randy.maclockout)
  maclockout       terminal status / mode CLI
  install.sh       sudo ./install.sh URL MAC_KEY
  dev-remove.sh    development only
tools/send-test-workout.sh   fake readings through the real /api/workout path
existing-work/     the old Mac Lockout + Workout Gate code, for reference
```

## Restrictions: baseline vs active

These live in `lib/rules.js` and are changed with `/api/policy?key=ADMIN_KEY&set=<name>&value=<n>`.

| setting | baseline | stricter is |
|---|---|---|
| `workoutWindowHours` | 48 | lower |
| `nightStartHour` (NY) | 23 | earlier |
| `nightEndHour` (NY) | 5 | later |

- Stricter takes effect immediately.
- Looser, back toward the baseline, takes effect after 72 h.
- Past the baseline is refused.

---

## Setup (once, ~20 min)

### 1. Server

1. Push this repo to GitHub.
2. In Vercel, use **Add New → Project**, import the repo and set **Root Directory = `server`**.
3. Storage: create a free Upstash Redis database (Vercel → Storage, or console.upstash.com) and connect it to the project. All keys are prefixed `ml:`, so sharing Workout Gate's database also works.
4. Run `openssl rand -hex 24` three times and add the results as **Environment Variables**:

| Name | Value |
|---|---|
| `MAC_KEY` | new key |
| `PHONE_KEY` | new key (or reuse Workout Gate's, so only the Shortcut URL changes) |
| `ADMIN_KEY` | new key — keep it in Notes on your phone |
| `DEV_RECOVERY` | `on` (remove after development) |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | same as Workout Gate |
| `ALERT_EMAIL` | optional; defaults to `GMAIL_USER` |
| `MAC_HEALTHCHECK_URL` | ping URL of a new Healthchecks.io check (see below) |

5. Deploy. Then check it in a browser: `https://APP.vercel.app/api/permission?key=ADMIN_KEY` should say `"allowed": false, "reason": "workout_noncompliance"`. That's correct: a fresh database has no workouts.
6. `https://APP.vercel.app/api/admin?key=ADMIN_KEY&action=test-email` should send you an email.

**Healthchecks.io:** add a new check (separate from Workout Gate's). Period **1 minute**, grace as long as you want to tolerate silence (e.g. 30 min). Put its ping URL in `MAC_HEALTHCHECK_URL` and redeploy. Closing the lid also makes it go down, so pick the grace with that in mind.

### 2. iPhone Shortcut

In **Report Workout → Get Contents of URL**, change the URL to `https://APP.vercel.app/api/workout`. If you made a new `PHONE_KEY`, also set the `Authorization` header to `Bearer PHONE_KEY`. Nothing else changes.

> Workout Gate's server stops receiving workouts once the Shortcut points here. If you still want it to get them, add a second **Get Contents of URL** action to the Shortcut.

### 3. Mac

```
cd mac-lockout/mac
chmod +x install.sh maclockout maclockoutd.sh dev-remove.sh
sudo ./install.sh https://APP.vercel.app MAC_KEY
```

It always installs in **dryrun** mode.

```
maclockout                  # status: allowed?, reason, compliant until, last workout
maclockout log              # what the daemon did
sudo maclockout check       # ask the server right now, full answer
sudo maclockout mode enforce|dryrun
```

---

## Recovery (development only). Set up and verify BEFORE enforcing

**Layer 1: server override (from your phone).** Open:

```
https://APP.vercel.app/api/admin?key=ADMIN_KEY&action=override&minutes=60
```

The server answers ALLOW for that long, whatever the rules say, including at night. At the login window the Mac picks it up within 60 s. While you're logged in and denied, it picks it up within 10 s. End it with `&action=clear-override`. The override only works while `DEV_RECOVERY=on`. Delete that variable after development and the override no longer exists.

This covers: you can't get a workout in, the Shortcut fails, or there's a rule bug on the server.

**Layer 2: macOS Recovery.** This doesn't depend on any of this code, for when the Mac can't reach the server or the daemon misbehaves.

1. Shut down. On Apple silicon, hold the power button until "Loading startup options", then choose Options → Continue. On Intel, hold ⌘R at startup.
2. Pick your admin user and enter its password.
3. Open **Utilities → Terminal** and run:

   ```
   ls /Volumes/
   ```

   You're looking for "Macintosh HD - Data". If it's missing: Disk Utility → select it → Mount → password.
4. Run:

   ```
   mv "/Volumes/Macintosh HD - Data/Library/LaunchDaemons/com.randy.maclockout.plist" "/Volumes/Macintosh HD - Data/Users/Shared/"
   reboot
   ```

**Verify both before step 3 of the test:**

- **Layer 1:** run it during dry-run. `maclockout status` flips to ALLOWED with `DEV OVERRIDE: on`, then back after clear-override.
- **Layer 2:** boot into Recovery, open Terminal, run the `ls` and confirm the plist is listed. Don't move it. Reboot normally.

---

## Tomorrow's test

**1. Build.** Deploy the server, update the Shortcut, install on the Mac. (Setup above.)

**2. Test mode.** Mode is `dryrun` and there are no workouts on record.

- `maclockout` should show `DENIED: workout_noncompliance` and `YOU WOULD BE LOCKED OUT (dry run)`.
- A dialog appears: "YOU WOULD BE LOCKED OUT: workout_noncompliance". `maclockout log` has the same line.
- The browser at `/api/permission?key=ADMIN_KEY` shows the same reason. `/api/events?key=ADMIN_KEY` shows the `decision` event.
- After 5 minutes of use you should get the "in use while denied" email. That verifies the safeguard.
- Verify recovery layers 1 and 2 now.

**3. Real enforcement.** Save your work, then run `sudo maclockout mode enforce`.

- Within ~10 s a dialog says "This Mac is locked: workout_noncompliance. Logging out in 10 seconds." Then you're logged out.
- Log back in. You get logged out again ~10–30 s later. Repeat once to be sure.
- From your phone, `/api/events?key=ADMIN_KEY` shows the decisions.

**4. Exercise.** Do a qualifying workout (≥20 min, ≥5 min above 120 bpm) and run **Report Workout** on the iPhone.

- The Shortcut's response shows `"pass": true` and `"allowed": true`.
- `/api/permission?key=ADMIN_KEY` shows `"allowed": true` and a `compliantUntil` 48 h out.

If the Shortcut misbehaves, `tools/send-test-workout.sh URL PHONE_KEY` sends a synthetic qualifying workout through the same endpoint.

**5. Verify access.** Log in. The Mac stays usable (it rechecks within 10 s, sees ALLOW, cancels the logout).

- `maclockout` shows `ALLOWED`, `compliant until …` and `last workout …`.
- `maclockout log` and `/api/events` show the sequence: `DENIED: workout_noncompliance` → `workout-post (compliantAfter: true)` → `ALLOWED`.

To run it again: `/api/admin?key=ADMIN_KEY&action=reset-workouts`.

## Notes

- New York time: 23:00–05:00 NY is 00:00–06:00 in Campinas until Nov 1, then 01:00–07:00 (US DST ends). The zone is `TIMEZONE` in `lib/rules.js`.
- Offline for more than 15 min logs you out (fail closed). Tune with `LEASE_MAX_SECONDS`.
- Upstash budget: about 2 Redis commands per Mac check, once a minute. That stays well inside the free tier.
- HealthKit on the Mac: macOS still has no Health app or Health data store. A native Mac HealthKit reader would also need a paid developer account. The iPhone Shortcut stays the workout pathway.
