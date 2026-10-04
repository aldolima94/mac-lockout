import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide, detectSessions, compliance, applyChange, effectivePolicy, classifyChange,
  trackInUse, nightly, BASELINE, HOUR, MIN, LEASE_MAX_SECONDS,
} from "../lib/rules.js";

// Oct 5 2026: New York is on EDT (UTC-4).
const ny = (hhmm, day = "2026-10-05") => Date.parse(`${day}T${hhmm}:00-04:00`);
const base = effectivePolicy(null, 0);

function samples(endTs, minutes, bpm, everySec = 30) {
  const out = [];
  for (let t = endTs - minutes * MIN; t <= endTs; t += everySec * 1000) out.push({ t: new Date(t).toISOString(), bpm });
  return out;
}
const workout = (endTs, minutes = 25, bpm = 130) => detectSessions(samples(endTs, minutes, bpm));

test("nightly window is 22:00–05:00 New York", () => {
  assert.equal(nightly(ny("21:59"), base).active, false);
  assert.equal(nightly(ny("22:00"), base).active, true);
  assert.equal(nightly(ny("02:30"), base).active, true);
  assert.equal(nightly(ny("04:59"), base).active, true);
  assert.equal(nightly(ny("05:00"), base).active, false);
  assert.equal(nightly(ny("21:00"), base).secondsUntilStart, 3600);
});

test("satisfactory workout: ≥20 min with ≥5 min above 120 bpm", () => {
  assert.equal(workout(ny("10:00"), 25, 130)[0].pass, true);
  assert.equal(workout(ny("10:00"), 15, 130)[0].pass, false);      // too short
  assert.equal(workout(ny("10:00"), 30, 115)[0].pass, false);      // never elevated
  // 25 minutes, only the last 4 elevated
  const s = [...samples(ny("09:56"), 21, 100), ...samples(ny("10:00"), 4, 135).slice(1)];
  assert.equal(detectSessions(s)[0].pass, false);
});

test("compliance lasts 48 h after the workout ends", () => {
  const end = ny("10:00");
  const sessions = workout(end);
  assert.equal(compliance(end + 47 * HOUR, sessions, 48).compliant, true);
  assert.equal(compliance(end + 48 * HOUR, sessions, 48).compliant, false);
  assert.equal(compliance(end, [], 48).compliant, false);
});

test("decide: night beats workout; workout required in daytime", () => {
  const sessions = workout(ny("09:00"));
  assert.deepEqual(pick(decide({ now: ny("12:00"), sessions })), { allowed: true, reason: null });
  assert.deepEqual(pick(decide({ now: ny("23:30"), sessions })), { allowed: false, reason: "nightly_lockout" });
  assert.deepEqual(pick(decide({ now: ny("12:00"), sessions: [] })), { allowed: false, reason: "workout_noncompliance" });
  assert.deepEqual(pick(decide({ now: ny("23:30"), sessions: [] })), { allowed: false, reason: "nightly_lockout" });
});
const pick = d => ({ allowed: d.allowed, reason: d.reason });

test("lease: capped at 15 min, at night start, and at compliance expiry", () => {
  const sessions = workout(ny("09:00"));
  assert.equal(decide({ now: ny("12:00"), sessions }).leaseSeconds, LEASE_MAX_SECONDS);
  assert.equal(decide({ now: ny("21:55"), sessions }).leaseSeconds, 300);
  const expiring = workout(ny("12:00") - 48 * HOUR + 2 * MIN);
  assert.equal(decide({ now: ny("12:00"), sessions: expiring }).leaseSeconds, 120);
  assert.equal(decide({ now: ny("12:00"), sessions: [] }).leaseSeconds, 0);
});

test("dev override only counts when DEV_RECOVERY is on", () => {
  const override = { until: ny("23:45") };
  assert.equal(decide({ now: ny("23:30"), sessions: [], override, devRecovery: false }).allowed, false);
  const d = decide({ now: ny("23:30"), sessions: [], override, devRecovery: true });
  assert.equal(d.allowed, true);
  assert.equal(d.leaseSeconds, 15 * 60);
  assert.equal(d.devOverride.wouldOtherwiseBe.reason, "nightly_lockout");
  assert.equal(decide({ now: ny("23:50"), sessions: [], override, devRecovery: true }).allowed, false);
});

test("policy: stricter is immediate, looser waits 72 h, past baseline refused", () => {
  const t0 = ny("12:00");
  let r = applyChange(null, "workoutWindowHours", 36, t0);
  assert.equal(r.kind, "stricter");
  assert.equal(effectivePolicy(r.state, t0).workoutWindowHours, 36);

  r = applyChange(r.state, "workoutWindowHours", 48, t0 + HOUR);
  assert.equal(r.kind, "looser");
  assert.equal(effectivePolicy(r.state, t0 + 72 * HOUR).workoutWindowHours, 36);
  assert.equal(effectivePolicy(r.state, t0 + 73 * HOUR).workoutWindowHours, 48);

  assert.match(applyChange(null, "workoutWindowHours", 72, t0).error, /baseline/);
  assert.match(applyChange(null, "nightStartHour", 23, t0).error, /baseline/);   // later start = looser
  assert.match(applyChange(null, "nightEndHour", 4, t0).error, /baseline/);      // earlier end = looser
  assert.equal(applyChange(null, "nightStartHour", 21, t0).kind, "stricter");
  assert.match(classifyChange(base, "bogus", 1).error, /unknown/);
});

test("policy: tightening cancels a pending loosening", () => {
  const t0 = ny("12:00");
  let s = applyChange(null, "workoutWindowHours", 24, t0).state;
  s = applyChange(s, "workoutWindowHours", 48, t0).state;            // pending loosen
  s = applyChange(s, "workoutWindowHours", 24, t0 + HOUR).state;     // same value → cancels it
  assert.equal(effectivePolicy(s, t0 + 100 * HOUR).workoutWindowHours, 24);
});

test("a stricter workout window changes the decision immediately", () => {
  const sessions = workout(ny("12:00") - 40 * HOUR);
  const tight = applyChange(null, "workoutWindowHours", 36, ny("12:00")).state;
  assert.equal(decide({ now: ny("12:00"), sessions }).allowed, true);
  assert.equal(decide({ now: ny("12:00"), sessions, policyState: tight }).reason, "workout_noncompliance");
});

test("in-use safeguard: alert after 5 minutes of use while denied, then every 30", () => {
  let st = null, alerts = [], t0 = ny("12:00"), t = t0;
  for (let i = 0; i < 400; i++, t += 10_000) {   // ~66 minutes of reports every 10 s
    const r = trackInUse(st, { now: t, allowed: false, userPresent: true });
    st = r.state; if (r.sendAlert) alerts.push(Math.round((t - t0) / MIN));
  }
  assert.deepEqual(alerts, [5, 35, 65]);
  assert.equal(trackInUse(st, { now: t, allowed: true, userPresent: true }).state, null);
  // nobody at the screen never alerts
  const r = trackInUse(null, { now: t, allowed: false, userPresent: false });
  assert.equal(r.sendAlert, false);
});

test("baseline values are what Randy specified", () => {
  assert.equal(BASELINE.workoutWindowHours.value, 48);
  assert.equal(BASELINE.nightStartHour.value, 22);
  assert.equal(BASELINE.nightEndHour.value, 5);
});
