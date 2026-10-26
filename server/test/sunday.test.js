import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, detectSessions, effectivePolicy, applyChange, satisfactoryEnds, MIN, HOUR } from "../lib/rules.js";
import { sundayBank, mergeBrushes, sundayText, SUNDAY_BANK_FIRST } from "../lib/sunday.js";
import { trackUsage } from "../lib/usage.js";
import { fmtHM } from "../lib/time.js";

// São Paulo wall-clock time → ms (UTC-3 all year).  sp("2026-10-19 08:00")
const sp = s => Date.parse(`${s.replace(" ", "T")}:00-03:00`);
const policy = effectivePolicy(null, 0);
// The first limited week: Mon Oct 19 … Sun Oct 25 2026.
const WEEK = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
const MON_SAT = WEEK.slice(0, 6);

const brush = (day, hhmm = "08:00", seconds = 130) => ({ start: new Date(sp(`${day} ${hhmm}`)).toISOString(), end: new Date(sp(`${day} ${hhmm}`) + seconds * 1000).toISOString() });
const ends = days => days.map(d => sp(`${d} 07:00`));
const lateOn = days => ({ sundays: {}, lateNights: days });
const bank = (now, o = {}) => sundayBank({ now, policy, workoutEnds: o.workouts || [], brushes: o.brushes || [], usage: o.usage || null });

test("the first limited Sunday is Oct 25; Oct 18 has no limit", () => {
  assert.equal(SUNDAY_BANK_FIRST, "2026-10-25");
  const s18 = bank(sp("2026-10-18 12:00"));
  assert.equal(s18.isSunday, true);
  assert.equal(s18.limited, false);
  assert.equal(s18.exhausted, false);
  assert.equal(s18.secondsLeft, null);
  assert.equal(bank(sp("2026-10-19 08:00")).limited, true);
  assert.equal(bank(sp("2026-10-19 08:00")).sunday, "2026-10-25");
});

test("Randy's examples: base 4 h", () => {
  const sun = sp("2026-10-25 12:00");
  // Nothing earned (late every night, no workouts, no brushing).
  assert.equal(bank(sun, { usage: lateOn(MON_SAT) }).totalMin, 4 * 60);
  // Brush once a day, no streaks (every other day), late every night → 7h 30m.
  const once = bank(sun, { brushes: WEEK.map(d => brush(d)), workouts: ends(["2026-10-19", "2026-10-21", "2026-10-23"]), usage: lateOn(MON_SAT) });
  assert.equal(once.totalMin, 7 * 60 + 30);
  assert.equal(once.streakMin, 0);
  // Brush twice a day + 3 early nights, no streaks → 14 h (once Sunday's evening brush is in).
  const twice = bank(sp("2026-10-25 21:30"), {
    brushes: WEEK.flatMap(d => [brush(d, "08:00"), brush(d, "21:00")]),
    usage: lateOn(["2026-10-19", "2026-10-20", "2026-10-21"]),
  });
  assert.equal(twice.brushMin, 7 * 60);
  assert.equal(twice.earlyMin, 3 * 60);
  assert.equal(twice.totalMin, 14 * 60);
});

test("brushing: ≥ 2 min counts, at most 2 a day, only this week", () => {
  const sat = sp("2026-10-24 12:00");
  const b = bank(sat, { usage: lateOn(MON_SAT), brushes: [
    brush("2026-10-19", "08:00"), brush("2026-10-19", "13:00"), brush("2026-10-19", "21:00"),   // 3 on Monday → 2
    brush("2026-10-20", "08:00", 110),                                                         // 1:50 → nothing
    brush("2026-10-20", "21:00", 120),                                                         // exactly 2:00 → counts
    brush("2026-10-18", "08:00"),                                                              // last week → nothing
    brush("2026-10-25", "08:00"),                                                              // in the future → nothing yet
  ] });
  assert.equal(b.brushSessions, 3);
  assert.equal(b.brushMin, 90);
});

test("streaks: each day continuing a run earns 1 h; counting restarts Monday", () => {
  const sun = sp("2026-10-25 20:00");
  // Sun Oct 18 + Mon: Monday doesn't continue anything this week. Tue, Wed continue. Fri, Sat, Sun → 2.
  const w = ends(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-23", "2026-10-24", "2026-10-25"]);
  const b = bank(sun, { workouts: w, usage: lateOn(MON_SAT) });
  assert.equal(b.streakDays, 4);
  assert.equal(b.streakMin, 4 * 60);
  // A workout in the future doesn't count yet.
  assert.equal(bank(sp("2026-10-20 06:30"), { workouts: ends(["2026-10-19", "2026-10-20"]) }).streakDays, 0);
  assert.equal(bank(sp("2026-10-20 07:30"), { workouts: ends(["2026-10-19", "2026-10-20"]) }).streakDays, 1);
});

test("early nights: Mon–Sat, counted once the lockout starts, not if you were on at 21:xx", () => {
  assert.equal(bank(sp("2026-10-19 21:59")).earlyNights, 0);      // Monday night not over yet
  assert.equal(bank(sp("2026-10-19 22:00")).earlyNights, 1);
  assert.equal(bank(sp("2026-10-19 22:00"), { usage: lateOn(["2026-10-19"]) }).earlyNights, 0);
  assert.equal(bank(sp("2026-10-25 23:00")).earlyNights, 6);      // Sunday night never counts
});

test("usage: counts time at the screen between check-ins; sleep gaps and weekdays don't count", () => {
  const sun = "2026-10-25";
  let u = null, last = null;
  const at = (hhmm, present, spending = true) => {
    const now = sp(`${sun} ${hhmm}`);
    u = trackUsage(u, { now, userPresent: present, last, spending, policy });
    last = { at: now, userPresent: present };
  };
  at("10:00", true); at("10:01", true); at("10:02", true);   // 2 min
  at("10:03", false); at("10:04", true);                      // away at 10:03 → nothing
  at("10:05", true);                                          // 1 min
  at("11:00", true);                                          // asleep 55 min → nothing
  at("11:01", true, false);                                   // not counting (e.g. denied) → nothing
  assert.equal(u.sundays[sun], 3 * MIN);
  // Weekday: no minutes, but 21:xx at the screen marks a late night.
  u = null; last = null;
  const mon = sp("2026-10-19 21:30");
  u = trackUsage(u, { now: mon, userPresent: true, last: { at: mon - MIN, userPresent: true }, spending: false, policy });
  assert.deepEqual([u.sundays, u.lateNights], [{}, ["2026-10-19"]]);
  // 20:59 and 22:00 aren't the last hour.
  assert.deepEqual(trackUsage(null, { now: sp("2026-10-20 20:59"), userPresent: true, last: null, spending: false, policy }).lateNights, []);
});

test("decide: Sunday time runs out → sunday_time_used; night and workouts come first", () => {
  const workouts = detectSessions(Array.from({ length: 60 }, (_, i) => ({ t: new Date(sp("2026-10-24 10:00") + i * 30_000).toISOString(), bpm: 130 })));
  const usage = mins => ({ sundays: { "2026-10-25": mins * MIN }, lateNights: MON_SAT });
  const D = (now, mins, s = workouts) => decide({ now, sessions: s, usage: usage(mins) });
  const noon = sp("2026-10-25 12:00");
  assert.equal(D(noon, 0).sunday.totalMin, 240);
  assert.equal(D(noon, 239).allowed, true);
  assert.equal(D(noon, 239).leaseSeconds, 60);                 // the lease never outlasts your Sunday time
  assert.equal(D(noon, 240).reason, "sunday_time_used");
  assert.equal(D(noon, 240).leaseSeconds, 0);
  assert.equal(D(sp("2026-10-25 22:30"), 240).reason, "nightly_lockout");
  assert.equal(D(noon, 240, []).reason, "workout_noncompliance");
  const lastWeek = detectSessions(Array.from({ length: 60 }, (_, i) => ({ t: new Date(sp("2026-10-17 10:00") + i * 30_000).toISOString(), bpm: 130 })));
  assert.equal(D(sp("2026-10-18 12:00"), 9999, lastWeek).allowed, true); // before the first limited Sunday
  // A stricter base takes effect at once.
  const tight = applyChange(null, "sundayBaseHours", 3, noon).state;
  assert.equal(decide({ now: noon, sessions: workouts, usage: usage(200), policyState: tight }).reason, "sunday_time_used");
});

test("mergeBrushes: re-sent sessions aren't double counted", () => {
  const a = brush("2026-10-19", "08:00");
  const again = { start: new Date(Date.parse(a.start) + 20_000).toISOString(), end: a.end };
  const m = mergeBrushes(mergeBrushes([], [a], sp("2026-10-19 09:00")), [again, brush("2026-10-19", "21:00")], sp("2026-10-19 22:00"));
  assert.equal(m.length, 2);
});

test("status text is hours and minutes", () => {
  assert.equal(fmtHM(425), "7h 5m");
  assert.equal(fmtHM(240), "4h");
  assert.equal(fmtHM(45), "45m");
  const w = sundayText(bank(sp("2026-10-21 12:00"), { brushes: [brush("2026-10-19"), brush("2026-10-20")] }));
  assert.equal(w, "Sunday time banked for Sun, Oct 25: 7h\n  4h base + 1h brushing + 0m streaks + 2h early nights");
  const s = sundayText(bank(sp("2026-10-25 12:00"), { usage: { sundays: { "2026-10-25": 70 * MIN }, lateNights: MON_SAT } }));
  assert.equal(s, "Sunday time today: 2h 50m left\n  used 1h 10m of 4h\n  4h base + 0m brushing + 0m streaks + 0m early nights");
  assert.match(sundayText(bank(sp("2026-10-17 12:00"))), /no limit this Sunday .*starts Sun, Oct 25/);
});

test("late nights: only real use after 21:00 costs the hour", () => {
  const late = (hhmm, o = {}) => trackUsage(null, { now: sp(`2026-10-19 ${hhmm}`), userPresent: true, last: null, spending: false, policy, ...o }).lateNights;
  // Mac asleep, screen off (a dark wake): the daemon reports nobody there.
  assert.deepEqual(late("21:15", { userPresent: false }), []);
  // Walked away at 20:55; the screen stays lit until 21:05 → not a late night.
  assert.deepEqual(late("21:04", { idleSeconds: 9 * 60 }), []);
  // Touched it at 21:02 → late night.
  assert.deepEqual(late("21:04", { idleSeconds: 2 * 60 }), ["2026-10-19"]);
  // Last touched at 21:58, first check-in after that at 22:00 → still a late night.
  assert.deepEqual(late("22:00", { idleSeconds: 2 * 60 }), ["2026-10-19"]);
  // Old daemon (no idle time): same as before.
  assert.deepEqual(late("21:30"), ["2026-10-19"]);
  // Sunday minutes: a screen left lit after you walk away isn't use.
  const sun = (idle, lastIdle = 0) => trackUsage(null, { now: sp("2026-10-25 10:01"), userPresent: true, idleSeconds: idle, last: { at: sp("2026-10-25 10:00"), userPresent: true, idleSeconds: lastIdle }, spending: true, policy }).sundays["2026-10-25"];
  assert.equal(sun(600), undefined);
  assert.equal(sun(119), MIN);
  assert.equal(sun(30, 150), undefined);
});
