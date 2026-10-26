// Earning by the minute (from the week of Nov 2 2026): the Saturday bank, the
// Sunday bank's early nights, what counts as using the Mac, and the 25-minute workout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, detectSessions, effectivePolicy, minDurationFor, MIN, HOUR } from "../lib/rules.js";
import { saturdayBank, saturdayText, SATURDAY_BANK_FIRST, SATURDAY_MAX_MINUTES } from "../lib/saturday.js";
import { sundayBank } from "../lib/sunday.js";
import { trackUsage, isUsing, EARN_BY_MINUTE_FROM } from "../lib/usage.js";

// São Paulo wall-clock time → ms (UTC-3 all year).  sp("2026-11-02 08:00")
const sp = s => Date.parse(`${s.replace(" ", "T")}:00-03:00`);
const policy = effectivePolicy(null, 0);
// The first week earning by the minute: Mon Nov 2 … Sun Nov 8 2026.
const MON_FRI = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
const MON_SAT = [...MON_FRI, "2026-11-07"];

// The Mac checking in once a minute from `from` to `to` (São Paulo, same day).
// check(t) → { userPresent, idleSeconds }; default: using it.
function useMac(u, from, to, check = () => ({ userPresent: true, idleSeconds: 0 }), spending = false) {
  let last = null;
  for (let t = sp(from); t <= sp(to); t += MIN) {
    const c = check(t);
    u = trackUsage(u, { now: t, ...c, last, spending, policy });
    last = { at: t, ...c };
  }
  return u;
}
const sat = (now, usage) => saturdayBank({ now, policy, usage });
const sun = (now, usage) => sundayBank({ now, policy, usage });

test("the new rules start on the week of Nov 2; the first limited Saturday is Nov 7", () => {
  assert.equal(EARN_BY_MINUTE_FROM, "2026-11-02");
  assert.equal(SATURDAY_BANK_FIRST, "2026-11-07");
  assert.equal(SATURDAY_MAX_MINUTES, 16 * 60);
  assert.equal(sat(sp("2026-10-31 12:00")).limited, false);
  assert.equal(sat(sp("2026-11-02 12:00")).limited, true);
  assert.equal(sat(sp("2026-11-02 12:00")).saturday, "2026-11-07");
  // On Sunday it's already the coming Saturday, with nothing earned yet.
  assert.equal(sat(sp("2026-11-08 12:00")).saturday, "2026-11-14");
  assert.equal(sat(sp("2026-11-08 12:00")).totalMin, 0);
});

test("using = a screen on and touched in the last 2 minutes (or a video playing)", () => {
  assert.equal(isUsing({ userPresent: true, idleSeconds: 0 }), true);      // typing, or a video (the Mac sends 0)
  assert.equal(isUsing({ userPresent: true, idleSeconds: 119 }), true);
  assert.equal(isUsing({ userPresent: true, idleSeconds: 120 }), false);   // walked away, screen still lit
  assert.equal(isUsing({ userPresent: false, idleSeconds: 0 }), false);    // logged out, or every screen off
  assert.equal(isUsing({ userPresent: true }), true);                      // an older daemon: no idle time
  assert.equal(isUsing(null), false);
});

test("Saturday: off the Mac 6h 40m Mon–Fri → 6h 40m on Saturday", () => {
  // At the Mac 07:00–22:00 every weekday, except 80 minutes off each day (5 × 80 = 6h 40m).
  let u = null;
  for (const d of MON_FRI) { u = useMac(u, `${d} 07:00`, `${d} 12:00`); u = useMac(u, `${d} 13:20`, `${d} 22:00`); }
  const s = sat(sp("2026-11-06 23:00"), u);
  assert.equal(s.totalMin, 6 * 60 + 40);
  assert.equal(saturdayText(s), "Saturday time banked for Sat, Nov 7: 6h 40m\n  a minute for each minute off the Mac, Mon–Fri 07:00–22:00 (at most 16h)");
});

test("Saturday: at most 16 h, however long you were off", () => {
  let u = null;
  for (const d of MON_FRI) u = useMac(u, `${d} 07:00`, `${d} 18:00`);    // off 18:00–22:00 → 4 h a day, 20 h
  const s = sat(sp("2026-11-07 06:00"), u);
  assert.equal(s.offMin, 20 * 60);
  assert.equal(s.totalMin, 16 * 60);
  // A Mac that's asleep or shut down all week: the whole 75 h counts as off, still 16 h.
  assert.equal(sat(sp("2026-11-07 06:00"), null).totalMin, 16 * 60);
});

test("Saturday: it builds up as the week goes, and only Mon–Fri 07:00–22:00 counts", () => {
  assert.equal(sat(sp("2026-11-02 06:59")).totalMin, 0);
  assert.equal(sat(sp("2026-11-02 08:30")).totalMin, 90);                 // off since 07:00
  assert.equal(sat(sp("2026-11-03 07:00")).totalMin, 15 * 60);            // Monday was a whole day off
  // Use before 07:00 or on Saturday itself doesn't cost anything.
  let u = useMac(null, "2026-11-02 06:00", "2026-11-02 06:59");
  assert.equal(sat(sp("2026-11-02 08:00"), u).totalMin, 60);
});

test("21:00–22:00 off the Mac earns twice: Sunday early night and Saturday", () => {
  // Monday: at the Mac 07:00–21:00 and 21:30–22:00; off 21:00–21:30.
  let u = useMac(null, "2026-11-02 07:00", "2026-11-02 21:00");
  u = useMac(u, "2026-11-02 21:30", "2026-11-02 22:00");
  const now = sp("2026-11-02 22:00");
  assert.equal(sat(now, u).totalMin, 30);
  assert.equal(sun(now, u).earlyMin, 30);
});

test("early nights by the minute: partial credit, Mon–Sat, up to 6 h", () => {
  // Five minutes on at 21:30 on Monday → 55 minutes, not nothing.
  let u = useMac(null, "2026-11-02 21:30", "2026-11-02 21:35");
  assert.equal(sun(sp("2026-11-02 22:00"), u).earlyMin, 55);
  // It counts up during the hour.
  assert.equal(sun(sp("2026-11-02 21:20")).earlyMin, 20);
  // Every night Mon–Sat off the Mac → 6 h on Sunday; Sunday night itself never counts.
  assert.equal(sun(sp("2026-11-08 23:00")).earlyMin, 6 * 60);
  // Base 4 h + 6 h early nights.
  assert.equal(sun(sp("2026-11-08 12:00")).totalMin, 10 * 60);
  // At the Mac every one of those hours → nothing.
  u = null;
  for (const d of MON_SAT) u = useMac(u, `${d} 21:00`, `${d} 22:00`);
  assert.equal(sun(sp("2026-11-08 12:00"), u).earlyMin, 0);
});

test("the week before Nov 2 keeps the old all-or-nothing hour", () => {
  // Sunday Nov 1: Mon–Sat Oct 26–31, on at 21:30 on Monday only → 5 early nights = 5 h.
  const u = trackUsage(null, { now: sp("2026-10-26 21:30"), userPresent: true, idleSeconds: 0, last: null, spending: false, policy });
  const s = sun(sp("2026-11-01 12:00"), u);
  assert.equal(s.earlyNights, 5);
  assert.equal(s.earlyMin, 5 * 60);
});

test("a screen left lit after you walk away isn't use; a video is", () => {
  // Monday 21:00–22:00: touched it last at 21:10, the screen stayed on until 21:40.
  let u = useMac(null, "2026-11-02 21:00", "2026-11-02 21:40", t => ({ userPresent: true, idleSeconds: Math.max(0, (t - sp("2026-11-02 21:10")) / 1000) }));
  // Use: 21:00 until the check-in where it had been idle under 2 minutes (21:11) → 11 minutes.
  assert.equal(sun(sp("2026-11-02 22:00"), u).earlyMin, 60 - 11);
  // A movie 21:00–21:40 (the Mac reports idle 0 while a video keeps the screen on).
  u = useMac(null, "2026-11-02 21:00", "2026-11-02 21:40");
  assert.equal(sun(sp("2026-11-02 22:00"), u).earlyMin, 20);
  // Lid closed with a few-second dark wake: the daemon reports nobody there.
  u = useMac(null, "2026-11-02 21:15", "2026-11-02 21:16", () => ({ userPresent: false, idleSeconds: 0 }));
  assert.equal(sun(sp("2026-11-02 22:00"), u).earlyMin, 60);
});

test("Saturday spending: use counts down, nothing banked means no Mac on Saturday", () => {
  const workouts = detectSessions(Array.from({ length: 60 }, (_, i) => ({ t: new Date(sp("2026-11-06 10:00") + i * 30_000).toISOString(), bpm: 130 })));
  // At the Mac all week, 07:00–22:00: nothing earned.
  let u = null;
  for (const d of MON_FRI) u = useMac(u, `${d} 07:00`, `${d} 22:00`);
  const d0 = decide({ now: sp("2026-11-07 06:00"), sessions: workouts, usage: u });
  assert.deepEqual([d0.allowed, d0.reason, d0.saturday.totalMin], [false, "saturday_time_used", 0]);
  // 2 hours banked: allowed, the lease never outlasts it, and the minutes count down.
  const two = { ...u, used: { ...u.used, "2026-11-06": { daytime: 13 * HOUR, lastHour: HOUR } } };
  const d1 = decide({ now: sp("2026-11-07 09:00"), sessions: workouts, usage: two });
  assert.deepEqual([d1.allowed, d1.saturday.totalMin, d1.leaseSeconds], [true, 120, 15 * 60]);
  const spent = useMac(two, "2026-11-07 09:00", "2026-11-07 10:59", undefined, true);
  const d2 = decide({ now: sp("2026-11-07 10:59"), sessions: workouts, usage: spent });
  assert.deepEqual([d2.allowed, d2.saturday.leftMin, d2.leaseSeconds], [true, 1, 60]);
  const done = useMac(spent, "2026-11-07 10:59", "2026-11-07 11:00", undefined, true);
  const d3 = decide({ now: sp("2026-11-07 11:00"), sessions: workouts, usage: done });
  assert.deepEqual([d3.allowed, d3.reason], [false, "saturday_time_used"]);
  // Not limited before Nov 7, and the nightly lockout still comes first.
  assert.equal(decide({ now: sp("2026-10-31 12:00"), sessions: detectSessions(Array.from({ length: 60 }, (_, i) => ({ t: new Date(sp("2026-10-30 10:00") + i * 30_000).toISOString(), bpm: 130 }))), usage: null }).allowed, true);
  assert.equal(decide({ now: sp("2026-11-07 22:30"), sessions: workouts, usage: u }).reason, "nightly_lockout");
});

test("workouts: 25 minutes from Nov 1 (São Paulo); 20 before", () => {
  // A workout of `minutes` at 130 bpm, starting at São Paulo time `start`.
  const w = (start, minutes) => detectSessions(Array.from({ length: minutes * 2 + 1 }, (_, i) => ({ t: new Date(sp(start) + i * 30_000).toISOString(), bpm: 130 })))[0];
  assert.equal(w("2026-10-31 10:00", 22).pass, true);
  assert.equal(w("2026-10-31 23:50", 22).pass, true);     // started Saturday night, ends after midnight
  assert.equal(w("2026-11-01 00:00", 22).pass, false);
  assert.equal(w("2026-11-02 10:00", 22).pass, false);
  assert.equal(w("2026-11-02 10:00", 24).pass, false);
  assert.equal(w("2026-11-02 10:00", 25).pass, true);
  assert.equal(minDurationFor(sp("2026-10-31 23:59")), 20);
  assert.equal(minDurationFor(sp("2026-11-01 00:00")), 25);
  // A 22-minute workout on Oct 31 keeps you compliant for its 48 h, across Nov 1.
  const d = decide({ now: sp("2026-11-02 09:00"), sessions: [w("2026-10-31 10:00", 22)] });
  assert.equal(d.compliance.compliant, true);
});

test("the warning email says 25 minutes from Nov 1, 20 before", async () => {
  const { warning } = await import("../lib/messages.js");
  const text = now => warning({ now, since: now - HOUR, partnerAt: now + HOUR, partnerName: "Aldo", dayLeft: 2 }).text;
  assert.match(text(sp("2026-10-31 12:00")), /\(≥20 min with ≥5 min above 120 bpm\)/);
  assert.match(text(sp("2026-11-01 12:00")), /\(≥25 min with ≥5 min above 120 bpm\)/);
});
