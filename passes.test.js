import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, detectSessions, effectivePolicy, applyChange, satisfactoryEnds, HOUR, MIN, DAY } from "../lib/rules.js";
import {
  requestDayPass, confirmDayPass, cancelDayPass, scheduleVacation, moveVacation, cancelVacation,
  passSummary, settlePasses, asksDue, dayStatus, CONFIRM_WINDOW_MIN,
} from "../lib/passes.js";
import { nyLocalToUtc, parseStart } from "../lib/time.js";

// New York wall-clock time → ms.  ny("2026-10-05 12:00")
const ny = s => { const [d, t = "00:00"] = s.split(" "); const [y, mo, dd] = d.split("-").map(Number); const [h, mi] = t.split(":").map(Number); return nyLocalToUtc(y, mo, dd, h, mi); };

function workout(endTs, minutes = 25) {
  const out = [];
  for (let t = endTs - minutes * MIN; t <= endTs; t += 30_000) out.push({ t: new Date(t).toISOString(), bpm: 130 });
  return detectSessions(out);
}
const ctxAt = (now, sessions = [], policyState = null) =>
  ({ now, policy: effectivePolicy(policyState, now), workoutEnds: satisfactoryEnds(sessions, now) });
const D = (now, sessions = [], passes = [], policyState = null) => decide({ now, sessions, passes, policyState });

// A world: last workout Oct 1 10:00 → out of compliance from Oct 3 10:00.
const OLD = workout(ny("2026-10-01 10:00"));
let n = 0;
const ids = () => ({ id: `p${++n}`, token: `tok${n}` });

function request(passes, now, sessions = OLD, reason = "sick") {
  const d = D(now, sessions, passes);
  return requestDayPass(passes, ctxAt(now, sessions), { reason, compliance: d.compliance, ...ids() });
}
// request → confirm 35 min later → returns passes + times
function fullPass(passes, t0, sessions = OLD) {
  const r = request(passes, t0, sessions);
  assert.ok(!r.error, r.error);
  const c = confirmDayPass(r.passes, ctxAt(t0 + 35 * MIN, sessions), r.pass.token);
  assert.ok(!c.error, c.error);
  return c;
}

test("time: NY dates and starts", () => {
  assert.equal(new Date(ny("2026-10-05 12:00")).toISOString(), "2026-10-05T16:00:00.000Z");   // EDT
  assert.equal(new Date(ny("2026-12-20 00:00")).toISOString(), "2026-12-20T05:00:00.000Z");   // EST
  assert.equal(parseStart("2026-12-20"), ny("2026-12-20 00:00"));
  assert.equal(parseStart("2026-12-20T08:30"), ny("2026-12-20 08:30"));
  assert.equal(parseStart("2026-12-20T08:30:00Z"), Date.parse("2026-12-20T08:30:00Z"));
  assert.equal(parseStart("next tuesday"), null);
});

test("day pass: only when out of compliance, with a reason", () => {
  const t = ny("2026-10-05 12:00");
  assert.match(request([], t, workout(t - HOUR)).error, /in compliance until/);
  assert.match(request([], t, OLD, "").error, /reason/);
  const r = request([], t);
  assert.equal(r.error, undefined);
  assert.match(r.message, /The pass will unlock in about 1 hour/);
  assert.match(request(r.passes, t + MIN).error, /already have a day pass/);
});

test("day pass: request → ask email at 30 min → confirm → active 30 min later for 24 h", () => {
  const t0 = ny("2026-10-05 12:00");
  const r = request([], t0);
  assert.equal(dayStatus(r.pass, ctxAt(t0 + 10 * MIN)), "requested");
  assert.equal(asksDue(r.passes, ctxAt(t0 + 29 * MIN)).length, 0);
  assert.equal(asksDue(r.passes, ctxAt(t0 + 30 * MIN)).length, 1);
  assert.match(confirmDayPass(r.passes, ctxAt(t0 + 20 * MIN), r.pass.token).error, /Too early/);
  assert.match(confirmDayPass(r.passes, ctxAt(t0 + 40 * MIN), "nope").error, /isn't valid/);

  const c = confirmDayPass(r.passes, ctxAt(t0 + 40 * MIN), r.pass.token);
  const on = t0 + 70 * MIN;
  assert.equal(c.pass.activatesAt, on);
  assert.equal(D(on - MIN, OLD, c.passes).reason, "workout_noncompliance");
  const d = D(on, OLD, c.passes);
  assert.equal(d.allowed, true);
  assert.equal(d.compliance.via, "day_pass");
  assert.equal(d.compliance.until, new Date(on + 24 * HOUR).toISOString());
  assert.equal(d.workout.compliant, false);                        // real workouts unchanged
  assert.equal(D(on + 24 * HOUR, OLD, c.passes).reason, "workout_noncompliance");
  assert.equal(D(on + 24 * HOUR, OLD, c.passes).compliance.until, new Date(on + 24 * HOUR).toISOString());
});

test("day pass never touches the nightly lockout", () => {
  const t0 = ny("2026-10-05 12:00");
  const c = fullPass([], t0);
  const d = D(ny("2026-10-05 23:30"), OLD, c.passes);
  assert.equal(d.reason, "nightly_lockout");
  assert.equal(d.compliance.compliant, true);
});

test("day pass: not confirmed → lapses, not spent", () => {
  const t0 = ny("2026-10-05 12:00");
  const r = request([], t0);
  const lapse = t0 + 30 * MIN + CONFIRM_WINDOW_MIN * MIN;
  assert.equal(dayStatus(r.pass, ctxAt(lapse - MIN)), "requested");
  assert.equal(dayStatus(r.pass, ctxAt(lapse)), "lapsed");
  assert.match(confirmDayPass(r.passes, ctxAt(lapse), r.pass.token).error, /lapsed/);
  assert.equal(passSummary(r.passes, ctxAt(lapse)).day.leftThisMonth, 2);
  const s = settlePasses(r.passes, ctxAt(lapse + MIN));
  assert.equal(s.passes[0].lapsedAt, lapse);
  assert.deepEqual(s.notices.map(x => x.type), ["day-lapsed"]);
});

test("day pass: cancel before it activates (not spent); too late after", () => {
  const t0 = ny("2026-10-05 12:00");
  const c = fullPass([], t0);
  const x = cancelDayPass(c.passes, ctxAt(t0 + 50 * MIN));
  assert.equal(x.error, undefined);
  assert.equal(passSummary(x.passes, ctxAt(t0 + 2 * HOUR)).day.leftThisMonth, 2);
  assert.equal(D(t0 + 2 * HOUR, OLD, x.passes).allowed, false);
  assert.match(cancelDayPass(c.passes, ctxAt(t0 + 2 * HOUR)).error, /No day pass in progress/);
  assert.match(cancelDayPass(c.passes, ctxAt(t0 + 2 * HOUR), c.pass.token).error, /Too late/);
});

test("day pass: a workout before it activates cancels it, not spent", () => {
  const t0 = ny("2026-10-05 12:00");
  const c = fullPass([], t0);
  const sessions = [...OLD, ...workout(t0 + 60 * MIN)];          // workout ends 10 min before activation
  const ctx = ctxAt(t0 + 2 * HOUR, sessions);
  assert.equal(dayStatus(c.pass, ctx), "cancelled");
  assert.equal(passSummary(c.passes, ctx).day.leftThisMonth, 2);
  const s = settlePasses(c.passes, ctx);
  assert.equal(s.passes[0].cancelledBy, "workout");
  // a workout after it activated doesn't un-spend it
  const late = [...OLD, ...workout(t0 + 3 * HOUR)];
  assert.equal(dayStatus(c.pass, ctxAt(t0 + 4 * HOUR, late)), "active");
});

test("day pass: 2 per calendar month (NY), with a workout between passes", () => {
  let passes = fullPass([], ny("2026-10-05 12:00")).passes;           // active Oct 5 13:05 → Oct 6 13:05
  let sessions = [...OLD, ...workout(ny("2026-10-07 09:00"))];        // compliant until Oct 9 09:00
  passes = fullPass(passes, ny("2026-10-10 12:00"), sessions).passes;
  sessions = [...sessions, ...workout(ny("2026-10-12 09:00"))];       // compliant until Oct 14 09:00
  assert.match(request(passes, ny("2026-10-20 12:00"), sessions).error, /No day passes left this month/);
  assert.equal(request(passes, ny("2026-11-02 12:00"), sessions).error, undefined);
  // tightened to 1/month → immediate
  const tight = applyChange(null, "dayPassesPerMonth", 1, ny("2026-11-01 00:00")).state;
  const p1 = fullPass([], ny("2026-11-02 12:00"), sessions).passes;
  const s2 = [...sessions, ...workout(ny("2026-11-04 09:00"))];
  const d = decide({ now: ny("2026-11-10 12:00"), sessions: s2, passes: p1, policyState: tight });
  const r = requestDayPass(p1, { ...ctxAt(ny("2026-11-10 12:00"), s2, tight) }, { reason: "x".repeat(5), compliance: d.compliance, ...ids() });
  assert.match(r.error, /No day passes left/);
  assert.match(applyChange(null, "dayPassesPerMonth", 3, 0).error, /baseline/);
  assert.match(applyChange(null, "vacationGapDays", 60, 0).error, /baseline/);
  assert.equal(applyChange(null, "dayPassAskMinutes", 60, 0).kind, "stricter");
});

test("no pass right after another pass without a workout in between", () => {
  const passes = fullPass([], ny("2026-10-05 12:00")).passes;          // ends Oct 6 13:05
  assert.match(request(passes, ny("2026-10-06 14:00")).error, /No pass right after another pass/);
  // vacation after that day pass waits for a workout
  let v = scheduleVacation(passes, ctxAt(ny("2026-10-06 14:00")), { start: ny("2026-10-08 00:00"), id: "v1" });
  assert.equal(v.error, undefined);
  const at = ny("2026-10-08 12:00");
  assert.equal(passSummary(v.passes, ctxAt(at)).vacation.current.status, "waiting");
  assert.equal(D(at, OLD, v.passes).allowed, false);
  const s = settlePasses(v.passes, ctxAt(at));
  assert.deepEqual(s.notices.map(x => x.type), ["vacation-waiting", "day-active"]);
  assert.equal(settlePasses(s.passes, ctxAt(at + 5 * MIN)).notices.length, 0);   // told once
  // a workout arrives → vacation starts at the workout, end unchanged
  const sessions = [...OLD, ...workout(ny("2026-10-09 10:00"))];
  const view = passSummary(v.passes, ctxAt(ny("2026-10-09 11:00"), sessions)).vacation.current;
  assert.equal(view.status, "active");
  assert.equal(view.startAt, ny("2026-10-09 10:00"));
  assert.equal(view.endsAt, ny("2026-10-13 00:00"));
});

test("vacation: 24 h notice, 5 days of workout compliance, nights still locked", () => {
  const now = ny("2026-10-05 12:00");
  assert.match(scheduleVacation([], ctxAt(now), { start: now + 23 * HOUR, id: "v" }).error, /at least 24 h ahead/);
  assert.match(scheduleVacation([], ctxAt(now), { start: null, id: "v" }).error, /start must be/);
  const v = scheduleVacation([], ctxAt(now), { start: ny("2026-10-10 00:00"), id: "v" });
  assert.match(v.message, /Sat, Oct 10/);
  assert.match(scheduleVacation(v.passes, ctxAt(now), { start: ny("2026-12-10 00:00"), id: "w" }).error, /already have a vacation/);
  const mid = ny("2026-10-12 15:00");
  assert.equal(D(mid, OLD, v.passes).allowed, true);
  assert.equal(D(mid, OLD, v.passes).compliance.via, "vacation");
  assert.equal(D(ny("2026-10-12 23:30"), OLD, v.passes).reason, "nightly_lockout");
  assert.equal(D(ny("2026-10-15 06:00"), OLD, v.passes).reason, "workout_noncompliance");
  assert.equal(D(ny("2026-10-14 22:00") - MIN, OLD, v.passes).allowed, true);
});

test("vacation: move or cancel before it starts; started ones count", () => {
  const now = ny("2026-10-05 12:00");
  let v = scheduleVacation([], ctxAt(now), { start: ny("2026-10-10 00:00"), id: "v" }).passes;
  assert.match(moveVacation(v, ctxAt(now), { start: now + HOUR }).error, /24 h ahead/);
  v = moveVacation(v, ctxAt(now), { start: ny("2026-10-20 00:00") }).passes;
  assert.equal(passSummary(v, ctxAt(now)).vacation.current.start, ny("2026-10-20 00:00"));
  const c = cancelVacation(v, ctxAt(now));
  assert.equal(passSummary(c.passes, ctxAt(now)).vacation.leftThisYear, 4);
  // cancelled → a new one may be scheduled right away
  assert.equal(scheduleVacation(c.passes, ctxAt(now), { start: ny("2026-10-07 00:00"), id: "w" }).error, undefined);
  // after it starts: can't cancel or move, and it counts
  const started = settlePasses(v, ctxAt(ny("2026-10-20 01:00"))).passes;
  assert.equal(started[0].startedAt, ny("2026-10-20 00:00"));
  assert.match(cancelVacation(started, ctxAt(ny("2026-10-20 01:00"))).error, /No vacation/);
  assert.equal(passSummary(started, ctxAt(ny("2026-10-21 00:00"))).vacation.leftThisYear, 3);
});

test("vacation: one per rolling 90 days, 4 per calendar year", () => {
  let passes = [], sessions = [...OLD];
  const starts = ["2027-01-01", "2027-04-01", "2027-06-30", "2027-09-28"];
  for (const [i, s] of starts.entries()) {
    const at = ny(s + " 00:00");
    const r = scheduleVacation(passes, ctxAt(at - 2 * DAY, sessions), { start: at, id: `v${i}` });
    assert.equal(r.error, undefined, `${s}: ${r.error}`);
    passes = settlePasses(r.passes, ctxAt(at + MIN, sessions)).passes;
    sessions = [...sessions, ...workout(at + 6 * DAY)];               // a workout after each, for the chain rule
    if (i === 0) {   // 89 days later is too soon (Jan 1 → Mar 31); 90 days (Apr 1) is fine, DST or not
      const r2 = scheduleVacation(passes, ctxAt(ny("2027-02-01 00:00"), sessions), { start: ny("2027-03-31 00:00"), id: "x" });
      assert.match(r2.error, /Only one vacation per 90 days.*Thu, Apr 1, 12:00 AM NY/);
    }
  }
  const fifth = scheduleVacation(passes, ctxAt(ny("2027-12-20 00:00"), sessions), { start: ny("2027-12-28 00:00"), id: "x" });
  assert.match(fifth.error, /No vacation passes left for 2027/);
  assert.equal(scheduleVacation(passes, ctxAt(ny("2027-12-20 00:00"), sessions), { start: ny("2028-01-02 00:00"), id: "y" }).error, undefined);
});

test("vacation start cancels a pending day pass (not spent)", () => {
  const now = ny("2026-10-05 12:00");
  const v = scheduleVacation([], ctxAt(now), { start: ny("2026-10-07 00:00"), id: "v" }).passes;
  const r = request(v, ny("2026-10-06 23:50"));
  const s = settlePasses(r.passes, ctxAt(ny("2026-10-07 00:05")));
  assert.deepEqual(s.notices.map(x => x.type).sort(), ["day-cancelled-vacation", "vacation-started"]);
  assert.equal(passSummary(s.passes, ctxAt(ny("2026-10-07 01:00"))).day.leftThisMonth, 2);
});

test("vacation blocked if limits were tightened before it starts", () => {
  const now = ny("2026-10-05 12:00");
  const v = scheduleVacation([], ctxAt(now), { start: ny("2026-10-10 00:00"), id: "v" }).passes;
  const off = applyChange(null, "vacationsPerYear", 0, now).state;
  const ctx = ctxAt(ny("2026-10-10 12:00"), OLD, off);
  assert.equal(passSummary(v, ctx).vacation.current.status, "blocked");
  assert.equal(decide({ now: ctx.now, sessions: OLD, passes: v, policyState: off }).allowed, false);
});
