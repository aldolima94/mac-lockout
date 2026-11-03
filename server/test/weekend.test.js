// The weekend pool (from the week of Nov 9 2026): one budget for Saturday and
// Sunday, no base, at most 16 h, brushing gate, reading minute for minute.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, effectivePolicy, MIN, HOUR } from "../lib/rules.js";
import { weekendBank, weekendText, readingEvent, WEEKEND_POOL_FROM, WEEKEND_MAX_MINUTES, READ_MAX_SESSION_MINUTES } from "../lib/weekend.js";
import { trackUsage } from "../lib/usage.js";

// São Paulo wall-clock time → ms (UTC-3 all year).  sp("2026-11-09 08:00")
const sp = s => Date.parse(`${s.replace(" ", "T")}:00-03:00`);
const policy = effectivePolicy(null, 0);
// The first pool week: Mon Nov 9 … Sun Nov 15 2026.
const [MON, TUE, WED, THU, FRI, SAT, SUN] = ["09", "10", "11", "12", "13", "14", "15"].map(d => `2026-11-${d}`);
const MON_FRI = [MON, TUE, WED, THU, FRI];

const brush = (day, hhmm = "08:30", seconds = 130) => ({ start: new Date(sp(`${day} ${hhmm}`)).toISOString(), end: new Date(sp(`${day} ${hhmm}`) + seconds * 1000).toISOString() });
const twiceADay = days => days.flatMap(d => [brush(d, "08:30"), brush(d, "21:30")]);
const onceADay = days => days.map(d => brush(d));
// The Mac checking in once a minute from `from` to `to` (São Paulo, same day), in use.
function useMac(u, from, to, spending = false) {
  let last = null;
  for (let t = sp(from); t <= sp(to); t += MIN) {
    u = trackUsage(u, { now: t, userPresent: true, idleSeconds: 0, last, spending, policy });
    last = { at: t, userPresent: true, idleSeconds: 0 };
  }
  return u;
}
// At the Mac 08:00–22:00 every weekday: nothing earned for being off it.
const allWeekAtTheMac = () => MON_FRI.reduce((u, d) => useMac(u, `${d} 08:00`, `${d} 22:00`), null);
const pool = (now, o = {}) => weekendBank({ now, policy, workoutEnds: o.workouts || [], brushes: o.brushes || [], usage: o.usage || null, reading: o.reading || null });
const workout = day => ({ start: new Date(sp(`${day} 07:00`)).toISOString(), end: new Date(sp(`${day} 07:30`)).toISOString(), durationMin: 30, elevatedMin: 10 });

test("the pool starts the week of Nov 9; the first pool weekend is Nov 14–15", () => {
  assert.equal(WEEKEND_POOL_FROM, "2026-11-09");
  assert.equal(WEEKEND_MAX_MINUTES, 16 * 60);
  assert.equal(pool(sp("2026-11-08 12:00")).limited, false);
  const w = pool(sp(`${MON} 12:00`));
  assert.equal(w.limited, true);
  assert.equal(w.saturday, SAT);
  assert.equal(w.sunday, SUN);
  assert.equal(pool(sp(`${SUN} 12:00`)).isWeekend, true);
  assert.equal(pool(sp(`${FRI} 23:00`)).isWeekend, false);
});

test("off the Mac counts from 08:00, not 07:00", () => {
  assert.equal(pool(sp(`${MON} 07:59`)).offMin, 0);
  assert.equal(pool(sp(`${MON} 09:00`)).offMin, 60);
  // Use before 08:00 costs nothing.
  const u = useMac(null, `${MON} 07:00`, `${MON} 07:59`);
  assert.equal(pool(sp(`${MON} 09:00`), { usage: u }).offMin, 60);
  // A whole weekday off the Mac: 08:00–22:00 = 14 h.
  assert.equal(pool(sp(`${TUE} 00:00`)).offMin, 14 * 60);
});

test("early nights earn on top of being off the Mac (21:00–22:00 counts twice)", () => {
  let u = useMac(null, `${MON} 08:00`, `${MON} 21:00`);
  const w = pool(sp(`${MON} 23:00`), { usage: u });
  assert.equal(w.offMin, 60);
  assert.equal(w.earlyMin, 60);
  // Saturday's early night counts too, for Sunday.
  u = allWeekAtTheMac();
  assert.equal(pool(sp(`${SAT} 23:00`), { usage: u }).earlyMin, 5 * 0 + 60);
});

test("brushing: fewer than 5 Mon–Fri → no weekend time at all", () => {
  const usage = allWeekAtTheMac();
  const workouts = [MON, TUE, WED].map(d => sp(`${d} 07:30`));
  const w = pool(sp(`${SAT} 09:00`), { usage, workouts, brushes: onceADay([MON, TUE, WED, THU]) });
  assert.equal(w.weekdayBrushes, 4);
  assert.equal(w.brushGateMet, false);
  assert.equal(w.earnedMin, 2 * 60 + 4 * 30);               // streaks + brushing
  assert.equal(w.totalMin, 0);
  assert.equal(w.exhausted, true);
});

test("brushing: 5 → 2h 30m, 10 → 6h, at most 2 a day, any days Mon–Fri", () => {
  const usage = allWeekAtTheMac();
  const at = sp(`${FRI} 23:00`);
  assert.equal(pool(at, { usage, brushes: onceADay(MON_FRI) }).totalMin, 150);
  assert.equal(pool(at, { usage, brushes: twiceADay(MON_FRI) }).totalMin, 6 * 60);
  // None Monday, twice Tuesday and Wednesday, none Thursday, once Friday: 5, passes.
  const mixed = [...twiceADay([TUE, WED]), brush(FRI)];
  const w = pool(at, { usage, brushes: mixed });
  assert.equal(w.weekdayBrushes, 5);
  assert.equal(w.brushGateMet, true);
  assert.equal(w.totalMin, 150);
  // Ten brushes on one day count as 2.
  const ten = Array.from({ length: 10 }, (_, i) => brush(MON, `0${i}:10`));
  assert.equal(pool(at, { usage, brushes: ten }).weekdayBrushes, 2);
  // Under 2 minutes doesn't count.
  assert.equal(pool(at, { usage, brushes: [brush(MON, "08:00", 110)] }).weekdayBrushes, 0);
});

test("brushing on the weekend adds 30 min to the weekend you're in, 2 a day", () => {
  const usage = allWeekAtTheMac();
  const week = onceADay(MON_FRI);
  const sat = [brush(SAT, "09:00"), brush(SAT, "13:00"), brush(SAT, "20:00")];
  const w = pool(sp(`${SAT} 21:00`), { usage, brushes: [...week, ...sat] });
  assert.equal(w.weekendBrushes, 2);
  assert.equal(w.totalMin, 150 + 60);
  // Weekend brushes don't count toward the 5.
  assert.equal(pool(sp(`${SAT} 21:00`), { usage, brushes: [...onceADay([MON, TUE, WED, THU]), ...sat] }).totalMin, 0);
});

test("reading: a minute for every minute, weekend included, this week only", () => {
  const usage = allWeekAtTheMac();
  const reading = { sessions: [
    { start: sp("2026-11-08 20:00"), end: sp("2026-11-08 21:00") },     // last week
    { start: sp(`${TUE} 22:30`), end: sp(`${TUE} 23:00`) },
    { start: sp(`${SAT} 10:00`), end: sp(`${SAT} 10:45`) },
  ] };
  const w = pool(sp(`${SAT} 12:00`), { usage, brushes: onceADay(MON_FRI), reading });
  assert.equal(w.readMin, 75);
  assert.equal(w.totalMin, 150 + 75);
});

test("at most 16 h, however much was earned", () => {
  // A Mac asleep all week: 5 × 14 h off + 6 early nights, plus brushing.
  const w = pool(sp(`${SAT} 06:00`), { brushes: twiceADay(MON_FRI) });
  assert.equal(w.offMin, 70 * 60);
  assert.equal(w.totalMin, 16 * 60);
});

test("Saturday and Sunday spend the same pool", () => {
  let u = allWeekAtTheMac();
  const brushes = twiceADay(MON_FRI);                         // 6 h
  u = useMac(u, `${SAT} 09:00`, `${SAT} 13:00`, true);         // 4 h on Saturday
  let w = pool(sp(`${SAT} 14:00`), { usage: u, brushes });
  assert.equal(w.usedMin, 4 * 60);
  assert.equal(w.leftMin, 2 * 60 + 60 - 60);                  // Saturday's early night isn't over yet
  u = useMac(u, `${SUN} 09:00`, `${SUN} 12:00`, true);         // 3 h on Sunday; Saturday 21–22 earned 1 h
  w = pool(sp(`${SUN} 12:00`), { usage: u, brushes });
  assert.equal(w.totalMin, 7 * 60);
  assert.equal(w.usedMin, 7 * 60);
  assert.equal(w.exhausted, true);
});

test("Books sessions: opens and closes", () => {
  let r = readingEvent(null, { now: sp(`${SAT} 10:00`), event: "open" });
  assert.equal(r.result, "started");
  r = readingEvent(r.state, { now: sp(`${SAT} 10:25`), event: "close" });
  assert.equal(r.minutes, 25);
  assert.deepEqual(r.state, { open: null, sessions: [{ start: sp(`${SAT} 10:00`), end: sp(`${SAT} 10:25`) }] });
  // A close with nothing open counts nothing.
  const c = readingEvent(r.state, { now: sp(`${SAT} 10:30`), event: "close" });
  assert.equal(c.minutes, 0);
  assert.equal(c.state.sessions.length, 1);
  // An open that never closed is dropped when the next one starts.
  let o = readingEvent(r.state, { now: sp(`${SAT} 11:00`), event: "open" });
  o = readingEvent(o.state, { now: sp(`${SAT} 15:00`), event: "open" });
  assert.match(o.result, /dropped/);
  o = readingEvent(o.state, { now: sp(`${SAT} 15:10`), event: "close" });
  assert.equal(o.minutes, 10);
  // Longer than 3 h: dropped, not counted.
  let l = readingEvent(null, { now: sp(`${SAT} 00:00`), event: "open" });
  l = readingEvent(l.state, { now: sp(`${SAT} 00:00`) + READ_MAX_SESSION_MINUTES * MIN + MIN, event: "close" });
  assert.equal(l.minutes, 0);
  assert.equal(l.state.sessions.length, 0);
  assert.match(l.result, /^dropped: open 3h 1m/);
});

test("decide: the old banks are gone from the pool week; the weekend locks and reading unlocks", () => {
  const sessions = [workout(TUE), workout(THU), workout(SAT)];   // no two days in a row: no streaks
  let usage = allWeekAtTheMac();
  const brushes = onceADay(MON_FRI);                          // 2h 30m
  const at = (s, o = {}) => decide({ now: sp(s), sessions, brushes: o.brushes || brushes, usage: o.usage || usage, reading: o.reading || null });

  let d = at(`${WED} 12:00`);
  assert.equal(d.saturday, null);
  assert.equal(d.sunday, null);
  assert.equal(d.allowed, true);

  // Sunday Nov 8 is still the old Sunday bank; its coming Saturday is the pool's.
  const old = decide({ now: sp("2026-11-08 12:00"), sessions: [workout("2026-11-08")] });
  assert.equal(old.sunday.sunday, "2026-11-08");
  assert.equal(old.saturday, null);
  assert.equal(old.weekend.limited, false);

  usage = useMac(usage, `${SAT} 09:00`, `${SAT} 11:30`, true);
  d = at(`${SAT} 11:30`, { usage });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "weekend_time_used");
  // 20 minutes in Books: 20 minutes of Mac.
  d = at(`${SAT} 12:00`, { usage, reading: { sessions: [{ start: sp(`${SAT} 11:35`), end: sp(`${SAT} 11:55`) }] } });
  assert.equal(d.allowed, true);
  assert.equal(d.weekend.leftMin, 20);
  assert.equal(d.leaseSeconds, 15 * 60);                    // the lease is at most 15 min anyway

  // Only 4 brushes: locked all weekend, with its own reason.
  d = at(`${SAT} 09:00`, { brushes: onceADay([MON, TUE, WED, THU]) });
  assert.equal(d.reason, "weekend_brushing_short");
});

test("the phone and Mac text", () => {
  const usage = allWeekAtTheMac();
  assert.equal(weekendText(pool(sp(`${THU} 23:00`), { usage, brushes: onceADay([MON, TUE, WED]) })), [
    "Weekend time banked for the weekend of Sat, Nov 14: 0 (1h 30m once you brush 5 times) (at most 16h)",
    "  brushing 3 of 5 needed Mon–Fri: no weekend time until 5",
    "  0m off the Mac + 0m early nights + 0m streaks + 1h 30m brushing + 0m reading",
  ].join("\n"));
  assert.equal(weekendText(pool(sp(`${SAT} 09:00`), { usage, brushes: twiceADay(MON_FRI) })), [
    "Weekend time: 6h left",
    "  used 0m of 6h (at most 16h)",
    "  0m off the Mac + 0m early nights + 0m streaks + 6h brushing + 0m reading",
  ].join("\n"));
  assert.equal(weekendText(pool(sp("2026-11-05 12:00"))),
    "Weekend time: one pool for Saturday and Sunday from the week of Mon, Nov 9 (first weekend Sat, Nov 14).");
});
