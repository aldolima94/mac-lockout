// The weekend pool from the week of Nov 16 2026: off the Mac 10:00–22:00
// Mon–Fri, streaks, 30 min a brush (2 a day), reading minute for minute (on top
// of off-the-Mac minutes on weekdays), at most 16 h, nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, effectivePolicy, MIN, HOUR } from "../lib/rules.js";
import { weekendBank, weekendText, NEW_RULES_FROM } from "../lib/weekend.js";
import { trackUsage, daytimeWindow } from "../lib/usage.js";
import { dayFromKey } from "../lib/time.js";

const sp = s => Date.parse(`${s.replace(" ", "T")}:00-03:00`);
const policy = effectivePolicy(null, 0);
const [MON, TUE, WED, THU, FRI, SAT, SUN] = ["16", "17", "18", "19", "20", "21", "22"].map(d => `2026-11-${d}`);
const MON_FRI = [MON, TUE, WED, THU, FRI];
const brush = (day, hhmm = "08:30") => ({ start: new Date(sp(`${day} ${hhmm}`)).toISOString(), end: new Date(sp(`${day} ${hhmm}`) + 130_000).toISOString() });
const workout = day => ({ start: new Date(sp(`${day} 07:00`)).toISOString(), end: new Date(sp(`${day} 07:30`)).toISOString(), durationMin: 30, elevatedMin: 10 });
function useMac(u, from, to, spending = false) {
  let last = null;
  for (let t = sp(from); t <= sp(to); t += MIN) {
    u = trackUsage(u, { now: t, userPresent: true, idleSeconds: 0, last, spending, policy });
    last = { at: t, userPresent: true, idleSeconds: 0 };
  }
  return u;
}
const pool = (now, o = {}) => weekendBank({ now, policy, workoutEnds: (o.workouts || []).map(w => Date.parse(w.end)), brushes: o.brushes || [], usage: o.usage || null, reading: o.reading || null });

test("the new rules start Mon Nov 16; the week of Nov 9 keeps 08:00", () => {
  assert.equal(NEW_RULES_FROM, "2026-11-16");
  assert.equal(new Date(daytimeWindow(dayFromKey("2026-11-13"), policy)[0]).toISOString(), "2026-11-13T11:00:00.000Z");   // 08:00
  assert.equal(new Date(daytimeWindow(dayFromKey(MON), policy)[0]).toISOString(), "2026-11-16T13:00:00.000Z");            // 10:00
  assert.equal(pool(sp(`${MON} 12:00`)).firstWeek, false);
  assert.equal(pool(sp("2026-11-15 12:00")).firstWeek, true);
});

test("off the Mac: 10:00–22:00, once; the Mac before 10:00 costs nothing", () => {
  // Off the Mac all Monday: 12 h, and the 21:00–22:00 hour isn't counted twice.
  let w = pool(sp(`${MON} 23:00`));
  assert.deepEqual([w.offMin, w.earlyMin], [720, 0]);
  // At the Mac 07:00–10:00 and 21:00–22:00 on Monday.
  let u = useMac(null, `${MON} 07:00`, `${MON} 10:00`);
  u = useMac(u, `${MON} 21:00`, `${MON} 22:00`);
  w = pool(sp(`${MON} 23:00`), { usage: u });
  assert.equal(w.offMin, 660);
  // The whole week off the Mac: 60 h, capped at 16 h for the weekend.
  w = pool(sp(`${SAT} 08:00`));
  assert.deepEqual([w.offMin, w.earnedMin, w.totalMin], [3600, 3600, 960]);
});

test("brushing: 30 min each, 2 a day, no gate and no bonus", () => {
  const u = MON_FRI.reduce((u, d) => useMac(u, `${d} 10:00`, `${d} 22:00`), null);   // nothing earned off the Mac
  let w = pool(sp(`${SAT} 08:00`), { usage: u, brushes: [brush(MON)] });
  assert.deepEqual([w.brushGate, w.brushGateMet, w.brushMin, w.totalMin], [0, true, 30, 30]);
  const ten = MON_FRI.flatMap(d => [brush(d, "08:00"), brush(d, "21:00"), brush(d, "23:00")]);   // 3 a day: 2 count
  w = pool(sp(`${SAT} 08:00`), { usage: u, brushes: ten });
  assert.deepEqual([w.weekdayBrushes, w.brushMin], [10, 300]);
  // On the weekend: adds to this weekend.
  w = pool(sp(`${SAT} 12:00`), { usage: u, brushes: [brush(SAT), brush(SAT, "09:00"), brush(SAT, "10:00")] });
  assert.equal(w.brushMin, 60);
});

test("streaks: still 1 h for each day that continues a run", () => {
  const u = MON_FRI.reduce((u, d) => useMac(u, `${d} 10:00`, `${d} 22:00`), null);
  const w = pool(sp(`${SAT} 08:00`), { usage: u, workouts: [workout(MON), workout(TUE), workout(WED), workout(FRI)] });
  assert.deepEqual([w.streakDays, w.streakMin], [2, 120]);
});

test("reading on a weekday counts on top of being off the Mac; on the weekend it's alone", () => {
  const reading = { sessions: [{ start: sp(`${MON} 12:00`), end: sp(`${MON} 13:00`) }, { start: sp(`${SAT} 12:00`), end: sp(`${SAT} 12:45`) }] };
  let w = pool(sp(`${MON} 23:00`), { reading });
  assert.deepEqual([w.offMin, w.readMin], [720, 60]);
  const u = MON_FRI.reduce((u, d) => useMac(u, `${d} 10:00`, `${d} 22:00`), null);
  w = pool(sp(`${SAT} 13:00`), { usage: u, reading });
  assert.deepEqual([w.offMin, w.readMin, w.totalMin], [0, 105, 105]);
});

test("decide on the weekend: brush first, then the pool", () => {
  const u = MON_FRI.reduce((u, d) => useMac(u, `${d} 10:00`, `${d} 22:00`), null);
  const sessions = [workout(FRI)];
  let d = decide({ now: sp(`${SAT} 09:00`), sessions, usage: u, brushes: [] });
  assert.equal(d.reason, "not_brushed_today");
  d = decide({ now: sp(`${SAT} 09:00`), sessions, usage: u, brushes: [brush(SAT)] });
  assert.deepEqual([d.allowed, d.weekend.leftMin], [true, 30]);
  const spent = useMac(u, `${SAT} 09:00`, `${SAT} 09:30`, true);
  d = decide({ now: sp(`${SAT} 09:30`), sessions, usage: spent, brushes: [brush(SAT)] });
  assert.equal(d.reason, "weekend_time_used");
});

test("text: no early nights, no brushing gate", () => {
  const t = weekendText(pool(sp(`${MON} 23:00`), { brushes: [brush(MON)] }));
  assert.equal(t, "Weekend time banked for the weekend of Sat, Nov 21: 12h 30m (at most 16h)\n  12h off the Mac + 0m streaks + 30m brushing + 0m reading");
});
