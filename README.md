# mac-lockout

One question: **is Randy permitted to use the MacBook right now?**

```
workout data (iPhone Shortcut) → server decides → root daemon on the Mac enforces
```

The server answers `GET /api/permission`:

1. 22:00–05:00 New York → `{"allowed": false, "reason": "nightly_lockout"}`
2. no satisfactory workout in the last 48 h, and no pass covering you → `{"allowed": false, "reason": "workout_noncompliance"}`
3. otherwise → `{"allowed": true, "reason": null}`

A satisfactory workout is one session of ≥20 min with ≥5 min above 120 bpm. The rule is unchanged from Workout Gate v2.

The Mac daemon asks the server every 60 s. While the answer is no, whoever is logged in gets logged out, and logged out again after every new login. Nothing shuts the Mac down. An ALLOW is only good for its lease (≤15 min, and never past the moment the answer flips). If the daemon can't get a fresh ALLOW, it denies with `no_recent_allow`.

**Email safeguard.** If the Mac keeps reporting someone logged in while the answer is no, for more than 5 minutes, the server emails you, and again every 30 minutes while it continues.

**Stop alarm.** When the daemon is stopped (unloaded, or the Mac shuts down), it sends Healthchecks a "start" signal. The next time the daemon checks in, the server sends "success". If no success arrives within the check's grace time, Healthchecks alerts you. Sleep and a closed lid don't stop the daemon, so they never trigger it. A normal restart comes back in minutes. A shutdown that stays off longer than the grace time does trigger it, except during a vacation pass (see below).

## Passes

Passes cover the **workout rule only**. The nightly lockout has no exceptions, ever.

**Day pass:** 2 per calendar month (New York time). Each covers 24 h.

1. You request it from your phone, with a short reason. This only works while you're **out of** compliance. The answer says "the pass will unlock in about 1 hour".
2. 30 minutes later you get an email: "are you sure?" The link in it opens a page with **Yes, I'm sure** / **No, cancel it**. It stays valid for 2 hours.
3. The pass activates 30 minutes after you confirm.

- Not confirmed in time → it lapses. It's never used and not spent.
- Cancel any time before it activates (phone or the email page) → not spent.
- A workout arrives before it activates → cancelled automatically, not spent.
- A pending request already counts against the month. If it lapses or is cancelled, you get it back.

**Vacation pass:** 5 days of workout compliance.

- Schedule it at least 24 h ahead. Move it or cancel it any time before it starts.
- Only vacations that actually started count. The limits are one per rolling 90 days (counted in New York calendar days) and 4 per calendar year.
- While it's active, and for 12 h after it ends, shutting the Mac down won't set off the Healthchecks alarm. (The scheduler keeps the check green.) If the Mac still hasn't checked in 12 h after the vacation ends, the alarm is re-armed with its normal 1-hour grace.
- A vacation that starts while a day pass is pending cancels that day pass (not spent).

**Both:** no pass can follow another pass unless you've done a real workout after the previous pass started. A vacation due to start without one waits ("waiting for a workout"). It starts the moment a workout arrives, and still ends on its original date.

You get an email when a day pass activates, lapses or is cancelled, and when a vacation starts, waits or can't start.

## Accountability partner

Your partner holds the **admin key**: rule changes and admin actions. You hold the **user key**: status, events and passes. (The handover plan is below.)

**Escalation.** When you're out of workout compliance (no workout, no pass covering you):

1. A **warning to you only**, at the first scheduler run after compliance runs out.
2. **24 h after compliance ran out:** an email to both of you. Yours is in English. His is in Portuguese, in his time zone. This repeats **every 24 h** until you're back.
3. Back in compliance, by a workout or a pass that activates → he's told, if he was ever emailed.

The clock runs from when compliance ran out and never resets. The **first** day-pass request in a stretch holds the emails while it's pending. If it lapses or is cancelled, whatever is overdue goes out at the next run. Later requests in the same stretch hold nothing, so request → lapse → request can't stall it. He's never emailed sooner than 1 h after your warning.

**"Mac in use while denied" emails:** the first one in an episode goes to you only, later ones to both of you.

## Layout

```
server/            Vercel project (root directory = server)
  lib/rules.js       the rules and ALL baselines. Pure functions; decide() is the whole decision.
  lib/passes.js      day + vacation passes (pure)
  lib/escalation.js  partner escalation + the vacation shutdown-alarm logic (pure, timings at the top)
  lib/time.js        New York time helpers
  lib/messages.js    email texts (yours in English, your partner's in Portuguese)
  lib/store.js       Redis keys, auth, event log, email
  api/permission     the Mac asks here (MAC_KEY); you can look too (USER_KEY / ADMIN_KEY)
  api/workout        the iPhone Shortcut posts heart-rate readings here (PHONE_KEY)
  api/pass           your passes, from the phone (USER_KEY)
  api/confirm        the "are you sure?" link from the email (the link's token is the key)
  api/tick           the scheduler, every 5 min (CRON_KEY)
  api/policy         view (USER_KEY) / change (ADMIN_KEY) restrictions
  api/admin          dev recovery override, reset workouts, test email (ADMIN_KEY)
  api/events         what happened and why (USER_KEY / ADMIN_KEY)
  test/              unit tests, end-to-end API tests, a simulated Mac run
                     (npm test; bash test/simulate-mac.sh)
mac/
  maclockoutd.sh   the root daemon (launchd: com.randy.maclockout)
  maclockout       terminal status / mode CLI
  install.sh       sudo ./install.sh URL MAC_KEY
  dev-remove.sh    development only
tools/send-test-workout.sh   fake readings through the real /api/workout path
existing-work/     the old Mac Lockout + Workout Gate code, for reference
```

## Restrictions: baseline vs active

These live in `lib/rules.js`. Only the admin key can change them: `/api/policy?key=ADMIN_KEY&set=<name>&value=<n>`. Anyone with your user key can view them at `/api/policy?key=USER_KEY`.

| setting | baseline | stricter is |
|---|---|---|
| `workoutWindowHours` | 48 | lower |
| `nightStartHour` (NY) | 22 | earlier |
| `nightEndHour` (NY) | 5 | later |
| `dayPassesPerMonth` | 2 | lower (0 = off) |
| `dayPassHours` | 24 | lower |
| `dayPassAskMinutes` (request → "are you sure?") | 30 | higher |
| `dayPassActivateMinutes` (confirm → active) | 30 | higher |
| `vacationDays` | 5 | lower |
| `vacationsPerYear` | 4 | lower (0 = off) |
| `vacationGapDays` | 90 | higher |
| `vacationNoticeHours` | 24 | higher |

- Stricter takes effect immediately.
- Looser, back toward the baseline, takes effect after 72 h.
- Past the baseline is refused.
- Fixed (not settings): the confirm link lasts 2 h (`CONFIRM_WINDOW_MIN` in `lib/passes.js`). The escalation timings 0 h / 24 h / every 24 h / 1 h lead, and the 12 h vacation slack, are at the top of `lib/escalation.js`.

---

## Setup (once, ~30 min)

### 1. Server

1. Push this repo to GitHub.
2. In Vercel, use **Add New → Project**, import the repo and set **Root Directory = `server`**.
3. Storage: create a free Upstash Redis database (Vercel → Storage, or console.upstash.com) and connect it to the project. All keys are prefixed `ml:`, so sharing Workout Gate's database also works.
4. Run `openssl rand -hex 24` once per key and add the results as **Environment Variables**:

| Name | Value |
|---|---|
| `MAC_KEY` | new key (the Mac daemon) |
| `PHONE_KEY` | new key (or reuse Workout Gate's, so only the Shortcut URL changes) |
| `USER_KEY` | new key: **yours**, for status and passes. Keep it in Notes on your phone. |
| `ADMIN_KEY` | new key: rule changes and admin actions. Yours during development; after the handover only your partner knows it. |
| `CRON_KEY` | new key, for the scheduler |
| `DEV_RECOVERY` | `on` (remove after development) |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | same as Workout Gate |
| `ALERT_EMAIL` | optional; defaults to `GMAIL_USER` |
| `PARTNER_EMAIL` | your partner's Gmail address. Leave it empty until he's agreed; until then everything goes to you only. |
| `PARTNER_NAME` | his first name, as used in his emails ("Oi …") |
| `PARTNER_TIMEZONE` | optional; defaults to `America/Sao_Paulo` (the times in his emails) |
| `MAC_HEALTHCHECK_URL` | ping URL of a new Healthchecks.io check (see below) |
| `CRON_HEALTHCHECK_URL` | ping URL of a second Healthchecks.io check, for the scheduler (see step 2) |

5. Deploy. Then check it in a browser: `https://APP.vercel.app/api/permission?key=USER_KEY` should say `"allowed": false, "reason": "workout_noncompliance"`. That's correct: a fresh database has no workouts.
6. `https://APP.vercel.app/api/admin?key=ADMIN_KEY&action=test-email` should send you an email. If `PARTNER_EMAIL` is set, he gets a short test in Portuguese.

**Healthchecks.io:** add a new check (separate from Workout Gate's). Under **Change Schedule**, set:

- **Period: 30 days.** Plain silence (vacation, lid closed) only alarms after a month.
- **Grace time: 1 hour.** That's how long the daemon may be stopped before you're alerted.

Put its ping URL in `MAC_HEALTHCHECK_URL` in Vercel and redeploy. The same URL goes to the Mac installer.

### 2. Scheduler (free, every 5 minutes)

The day-pass emails, the escalation and the vacation alarm need something that calls `/api/tick` every 5 minutes. Vercel's free cron only runs once a day, so use **cron-job.org** (free, no paid tier needed). Upstash QStash also works, see below.

1. **Healthchecks first:** add a second check named "Mac Lockout scheduler". Under **Change Schedule**, set **Period 5 minutes** and **Grace 15 minutes**. Copy its ping URL into Vercel as `CRON_HEALTHCHECK_URL`, then redeploy.
2. **cron-job.org:** sign up, then **Create cronjob**:
   - URL: `https://APP.vercel.app/api/tick`
   - Schedule: every 5 minutes
   - **Advanced → Headers:** add `Authorization` = `Bearer CRON_KEY`
   - Under notifications, turn on "notify me when the job fails" (optional; Healthchecks already covers it).
3. Click **Test run**. The response should be `{"ok":true,...}`, and the scheduler check in Healthchecks should turn green.

Each run pings the scheduler check. It sends `/fail` if anything went wrong, including any email that failed to send since the last run (for example, a revoked Gmail app password). If the runs stop, the check goes down after 15 min. The endpoint always answers 200 so cron-job.org never auto-disables the job; problems are reported through Healthchecks.

*Alternative, Upstash QStash (free tier: 1,000 messages/day; this uses 288).* In the Upstash console go to **QStash → Schedules → Create**. Set the destination to `https://APP.vercel.app/api/tick`, the cron to `*/5 * * * *`, and add the header `Upstash-Forward-Authorization: Bearer CRON_KEY`.

### 3. iPhone Shortcut

In **Report Workout → Get Contents of URL**, change the URL to `https://APP.vercel.app/api/workout`. If you made a new `PHONE_KEY`, also set the `Authorization` header to `Bearer PHONE_KEY`. Nothing else changes.

> Workout Gate's server stops receiving workouts once the Shortcut points here. If you still want it to get them, add a second **Get Contents of URL** action to the Shortcut.

### 4. Passes from the iPhone (Shortcuts)

All pass actions go to `https://APP.vercel.app/api/pass` with your **USER_KEY**. `format=text` gives a short plain answer, followed by your status.

**Quickest:** save this as a Safari bookmark or Home Screen icon:
`https://APP.vercel.app/api/pass?key=USER_KEY&format=text`. It shows passes left, what's pending, and what's scheduled.

**Shortcut "Day pass":**

1. **Ask for Input** (Text), prompt "Reason?"
2. **Get Contents of URL**:
   - URL `https://APP.vercel.app/api/pass`, Method **POST**
   - Headers: `Authorization` = `Bearer USER_KEY`
   - Request Body **JSON**: `action` = `day`, `reason` = *Provided Input*, `format` = `text`
3. **Show Result** (*Contents of URL*).

**Shortcut "Vacation":**

1. **Ask for Input** (Date), prompt "First day?"
2. **Format Date** with a custom format: `yyyy-MM-dd`
3. **Get Contents of URL**, same as above, with Request Body `action` = `vacation`, `start` = *Formatted Date*, `format` = `text`
4. **Show Result**

The vacation starts at midnight New York time that day (01:00/02:00 in Campinas). For an exact time, send `start=2026-12-20T08:00` (New York time).

**Other actions** (same URL and header, `format=text`):

| `action` | what |
|---|---|
| *(none)* | status |
| `cancel-day` | cancel the day pass in progress (before it activates) |
| `move-vacation` + `start` | move the vacation (before it starts; 24 h notice again) |
| `cancel-vacation` | cancel it (before it starts) |

`maclockout status` on the Mac shows the same passes section.

### 5. Mac

```
cd mac-lockout/mac
chmod +x install.sh maclockout maclockoutd.sh dev-remove.sh
sudo ./install.sh https://APP.vercel.app MAC_KEY HEALTHCHECK_PING_URL
```

It always installs in **dryrun** mode.

```
maclockout                  # status: allowed?, reason, compliant until (and via what), last workout, passes
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

**1. Build.** Deploy the server, set up the scheduler, update the Shortcut, install on the Mac. (Setup above.) Leave `PARTNER_EMAIL` empty while testing, so a test lockout doesn't email him.

**2. Test mode.** Mode is `dryrun` and there are no workouts on record.

- `maclockout` should show `DENIED: workout_noncompliance` and `YOU WOULD BE LOCKED OUT (dry run)`.
- A dialog appears: "YOU WOULD BE LOCKED OUT: workout_noncompliance". `maclockout log` has the same line.
- The browser at `/api/permission?key=USER_KEY` shows the same reason. `/api/events?key=USER_KEY` shows the `decision` event.
- Within 5 minutes the scheduler sends you the "you're out of workout compliance" warning.
- After 5 minutes of use you should get the "in use while denied" email. That verifies the safeguard.
- Verify recovery layers 1 and 2 now.

**3. Real enforcement.** Save your work, then run `sudo maclockout mode enforce`.

- Within ~10 s a dialog says "This Mac is locked: workout_noncompliance. Logging out in 10 seconds." Then you're logged out.
- Log back in. You get logged out again ~10–30 s later. Repeat once to be sure.
- From your phone, `/api/events?key=USER_KEY` shows the decisions.

**4. Exercise.** Do a qualifying workout (≥20 min, ≥5 min above 120 bpm) and run **Report Workout** on the iPhone.

- The Shortcut's response shows `"pass": true` and `"allowed": true`.
- `/api/permission?key=USER_KEY` shows `"allowed": true` and `compliance.until` 48 h out.

If the Shortcut misbehaves, `tools/send-test-workout.sh URL PHONE_KEY` sends a synthetic qualifying workout through the same endpoint.

**5. Verify access.** Log in. The Mac stays usable (it rechecks within 10 s, sees ALLOW, cancels the logout).

- `maclockout` shows `ALLOWED`, `compliant until …` and `last workout …`.
- `maclockout log` and `/api/events` show the sequence: `DENIED: workout_noncompliance` → `workout-post (compliantAfter: true)` → `ALLOWED`.

To run it again: `/api/admin?key=ADMIN_KEY&action=reset-workouts`.

**6. Passes, without spending one.** First `/api/admin?key=ADMIN_KEY&action=reset-workouts`, so you're out of compliance.

- Run the **Day pass** Shortcut with reason "test". It answers "The pass will unlock in about 1 hour", and `maclockout` shows `requested: confirm from the email before …`.
- ~30 min later the "are you sure?" email arrives. Open the link and tap **Yes, I'm sure**. `maclockout` shows `confirmed: activates …`.
- Before it activates, open the same link again and tap **Cancel it**. Status shows `2 of 2 left this month`, and `/api/events` shows `pass-day` → `pass-confirm` → `pass-cancel`.
- Run the **Vacation** Shortcut with a date at least 2 days out. `maclockout` shows `scheduled …`. Then cancel it: `/api/pass?key=USER_KEY&action=cancel-vacation&format=text`.
- Do a workout to get back in compliance.

## Notes

- New York time: 22:00–05:00 NY is 23:00–06:00 in Campinas until Nov 1, 2026, then 00:00–07:00 until US DST starts again (Mar 14, 2027). The zone is `TIMEZONE` in `lib/rules.js`.
- Offline for more than 15 min logs you out (fail closed). Tune with `LEASE_MAX_SECONDS`.
- Upstash budget: about 2 Redis commands per Mac check (once a minute), plus about 4 per scheduler run (every 5 min). That's ~130k a month against the free tier's 500k.
- Vercel Hobby allows 12 functions per deployment. This uses 8 (one per file in `api/`).
- Everything is free: Vercel Hobby, Upstash free, cron-job.org, Healthchecks Hobbyist (2 of 20 checks), and Gmail.
- HealthKit on the Mac: macOS still has no Health app or Health data store. A native Mac HealthKit reader would also need a paid developer account. The iPhone Shortcut stays the workout pathway.

---

## Handing the keys to your partner

The goal: he owns everything that could switch the system off or change the rules, and you keep only what you need day to day. It takes about an hour, together, on a laptop.

**Do it early**, before you've used any passes. The move starts a fresh database: your pass history and event log start over, and a workout right after the move puts you back in compliance.

**What you keep:** `USER_KEY` (status and passes), `PHONE_KEY` (the workout Shortcut), `MAC_KEY` (it's on your Mac), the Gmail app password that sends the emails, and the cron-job.org job.
**What only he has:** the GitHub, Vercel, Upstash and Healthchecks logins, plus `ADMIN_KEY`.

1. **His accounts.** He creates (or already has) a GitHub account, then signs up at vercel.com with **Continue with GitHub**, and at healthchecks.io with his Gmail. He picks the passwords himself, saves them in his phone's password manager, and turns on two-step verification with his phone. You don't look.

2. **Code (GitHub).** In your repo go to **Settings → Danger Zone → Transfer**, type his username, and confirm. He accepts from the email within a day. GitHub adds you back as a collaborator, so he removes you: **Settings → Collaborators → Remove**.
   - Optional: he makes the repo **public** (it holds no keys), so you can still read it and propose changes as pull requests.
   - Every code change is a rule change. He only clicks Merge on something you've explained in plain words, and he can always say no.

3. **Server (Vercel + Upstash).** Vercel's free plan can't hand a project to another person, so he sets up a fresh copy under his account:
   - In Vercel: **Add New → Project**, import the repo, **Root Directory = `server`**.
   - **Storage → Create → Upstash Redis (free)**, connected to the project.
   - **Environment variables:**
     - You type `MAC_KEY`, `PHONE_KEY`, `USER_KEY`, `CRON_KEY` (new values you generate), `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `ALERT_EMAIL` (optional), `MAC_HEALTHCHECK_URL` and `CRON_HEALTHCHECK_URL`.
     - He types `PARTNER_EMAIL` (his Gmail) and `PARTNER_NAME`.
     - He types `ADMIN_KEY` himself, with you looking away. It's a long random password he makes up (e.g. five random words plus a number), saved in his phone's password manager.
     - Leave out `DEV_RECOVERY` unless you're still in development.
   - Deploy. He opens `https://NEW-APP.vercel.app/api/admin?key=ADMIN_KEY&action=test-email`, and you both get a test email.

4. **Alarms (Healthchecks).** In your Healthchecks project:
   - **Settings → Team Access**: invite his email. He accepts.
   - **Settings → Transfer Project…**: pick him. He confirms from the email. The checks and their ping URLs stay the same.
   - He then makes sure the email notifications go to **him** (and to you if he likes), and removes you from the team, or sets you to read-only if offered.

5. **Point everything at the new server.**
   - In cron-job.org, change the job URL to `https://NEW-APP.vercel.app/api/tick` and the header to the new `CRON_KEY`. The job can stay in your account: if you pause it, his scheduler check goes down and he's told.
   - On the Mac: `cd mac-lockout/mac && sudo ./install.sh https://NEW-APP.vercel.app NEW_MAC_KEY HEALTHCHECK_PING_URL`. It keeps the current mode. Run `sudo maclockout mode enforce` if it's not already enforcing.
   - On the iPhone, change the URLs in **Report Workout**, **Day pass** and **Vacation**, and the key headers.
   - Do a workout and run **Report Workout**. `maclockout` should say ALLOWED.

6. **Close the old copy.** Delete your old Vercel project and its Upstash database, so nothing old answers on another URL.

**What he does from then on:** nothing, unless an email asks him to. He'll get:

- emails in Portuguese when you're out of compliance (from 24 h, then daily), when the Mac is used while it should be locked, and when you're back on track;
- Healthchecks alerts if the Mac's daemon stays off, if the scheduler stops, or if emails fail to send.

To change a rule, he opens `https://NEW-APP.vercel.app/api/policy?key=ADMIN_KEY&set=NAME&value=N`. Stricter takes effect now, looser after 72 h, and nothing can go past the baseline.

**Keep in mind.** Gmail revokes app passwords whenever you change your Google password. That breaks the emails, and the scheduler check reports it to him. So if you change your password, make a new app password and send it to him to update in Vercel.

## Making the partner a real incentive (ideas, not built)

1. **Money on the line.** Leave a deposit with him (e.g. R$ 300). Every partner email costs you R$ 50, which he keeps, or gives to a cause you'd hate to support. You refill when it runs low. Probably the strongest lever.
2. **He sees your passes.** A one-line copy to him whenever a day pass activates, with your reason. Passes stay legitimate, but they stop being invisible.
3. **He co-signs vacations.** A vacation starts only after he taps "ok" in an email. That's a natural check on "vacation" as an escape hatch.
4. **Weekly digest.** Sunday email to both of you: workouts this week, passes used, minutes the Mac was used while denied. Something to talk about when you see each other.
5. **Streak reward.** 4 clean weeks (no partner emails) → he picks a lunch or dinner and you pay. A miss resets the streak. Positive, and something he looks forward to.
6. **Work out together.** A standing weekly session with him (gym, run, football) that counts as one of your workouts. Skipping it then means standing someone up.
7. **Only he can add passes.** An admin action that grants a one-off extra day pass. Anything beyond your monthly allowance becomes a message to him explaining why.

## Known limits

- You have root on the Mac. So you hold `MAC_KEY`, `PHONE_KEY` and the Mac's Healthchecks ping URL, and could fake check-ins or workouts. That's anti-tampering, which is out of scope for now. Anything else you switch off (the scheduler, the emails, the daemon outside a vacation) is reported to him.
- During an active vacation, a removed daemon isn't noticed until 12 h after the vacation ends. If the Mac is used at night during a vacation with the daemon removed, nothing notices.
- The confirm link is the only key a confirmation needs, so don't forward that email.
