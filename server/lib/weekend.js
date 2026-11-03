// ─────────────────────────────────────────────────────────────────────────────
// The weekend pool. Pure functions only: no Redis, no network, no clock reads.
//
// From the week of WEEKEND_POOL_FROM, Saturday and Sunday (São Paulo) share one
// budget, earned that week (Monday–Sunday) with no base, at most 16 h:
//   • off the Mac: every minute Monday–Friday between 08:00 and the nightly
//     lockout (22:00) that you aren't using it earns a minute;
//   • early nights: every minute Monday–Saturday in the hour before the lockout
//     (21:00–22:00) off the Mac earns another minute (so that hour earns twice);
//   • workout streaks: the 2nd day in a row with a qualifying workout earns 1 h,
//     and each further day in a row another 1 h;
//   • brushing: each session of ≥ 2 min earns 30 min, at most 2 a day. 10 on
//     Monday–Friday earn 1 h more. Fewer than 5 on Monday–Friday: no weekend time
//     at all, whatever else was earned;
//   • reading in Apple Books: a minute for every minute, whenever it happens,
//     Saturday and Sunday included (lib/weekend.js readingEvent).
// Brushing and reading on the weekend add to the weekend you're in. Only time
// actually used is spent (lib/usage.js); it can all go on Saturday. What's left
// is gone when the week ends. Weeks before WEEKEND_POOL_FROM use the Saturday
// and Sunday banks (lib/saturday.js, lib/sunday.js).
// ─────────────────────────────────────────────────────────────────────────────

import { MIN, spDayNumber, spAt, mondayOf, dayKey, dayFromKey, fmtDay, fmtHM } from "./time.js";
import { WEEKEND_POOL_FROM, daytimeWindow, lastHourWindow, offMs } from "./usage.js";
import { BRUSH, STREAK_EARN_MINUTES } from "./sunday.js";
export { WEEKEND_POOL_FROM };

export const WEEKEND_MAX_MINUTES = 16 * 60;
export const BRUSH_GATE = 5;                          // brushes Mon–Fri, or no weekend time
export const BRUSH_BONUS = { at: 10, minutes: 60 };   // all 10 Mon–Fri brushes earn 1 h more
// A Books session longer than this is dropped, not counted: the phone was most
// likely locked or put down with Books still open.
export const READ_MAX_SESSION_MINUTES = 180;
const KEEP_DAYS = 21;

// inputs: { now, policy, workoutEnds: [ms], brushes: [{ start, end }], usage, reading: { sessions } }
export function weekendBank({ now, policy, workoutEnds = [], brushes = [], usage = null, reading = null }) {
  const today = spDayNumber(now);
  const monday = mondayOf(today), friday = monday + 4, saturday = monday + 5, sunday = monday + 6;
  const limited = monday >= dayFromKey(WEEKEND_POOL_FROM);

  // Off the Mac, Monday–Friday daytime; early nights, Monday–Saturday.
  let offTotal = 0, earlyTotal = 0;
  for (let n = monday; n <= friday; n++) offTotal += offMs(daytimeWindow(n, policy), now, usage?.used?.[dayKey(n)]?.daytime);
  for (let n = monday; n <= saturday; n++) earlyTotal += offMs(lastHourWindow(n, policy), now, usage?.used?.[dayKey(n)]?.lastHour);

  // Workout streaks: every day that continues a run of workout days earns.
  const workoutDays = new Set(workoutEnds.filter(t => t <= now).map(spDayNumber));
  let streakDays = 0, run = 0;
  for (let n = monday; n <= Math.min(today, sunday); n++) {
    run = workoutDays.has(n) ? run + 1 : 0;
    if (run >= 2) streakDays++;
  }

  // Brushing: sessions of ≥ 2 min, by São Paulo day, at most 2 a day.
  const perDay = {};
  for (const b of brushes || []) {
    const start = Date.parse(b.start), end = Date.parse(b.end);
    if (isNaN(start) || isNaN(end) || start > now || end - start < BRUSH.minMinutes * MIN) continue;
    const n = spDayNumber(start);
    if (n >= monday && n <= sunday) perDay[n] = Math.min(BRUSH.perDay, (perDay[n] || 0) + 1);
  }
  let weekdayBrushes = 0, weekendBrushes = 0;
  for (const [n, c] of Object.entries(perDay)) if (Number(n) <= friday) weekdayBrushes += c; else weekendBrushes += c;
  const brushGateMet = weekdayBrushes >= BRUSH_GATE;

  // Reading: finished Books sessions, the part inside this week.
  const [weekStart, weekEnd] = [spAt(monday), spAt(monday + 7)];
  let readTotal = 0;
  for (const r of reading?.sessions || []) readTotal += Math.max(0, Math.min(r.end, weekEnd, now) - Math.max(r.start, weekStart));

  const offMin = Math.floor(offTotal / MIN);
  const earlyMin = Math.floor(earlyTotal / MIN);
  const streakMin = streakDays * STREAK_EARN_MINUTES;
  const brushMin = (weekdayBrushes + weekendBrushes) * BRUSH.earnMinutes + (weekdayBrushes >= BRUSH_BONUS.at ? BRUSH_BONUS.minutes : 0);
  const readMin = Math.floor(readTotal / MIN);
  const earnedMin = offMin + earlyMin + streakMin + brushMin + readMin;
  const totalMin = brushGateMet ? Math.min(WEEKEND_MAX_MINUTES, earnedMin) : 0;

  const usedMs = (usage?.saturdays?.[dayKey(saturday)] || 0) + (usage?.sundays?.[dayKey(sunday)] || 0);
  const isWeekend = today >= saturday;
  const leftMs = Math.max(0, totalMin * MIN - usedMs);

  return {
    saturday: dayKey(saturday), saturdayDay: saturday, sunday: dayKey(sunday), limited, isWeekend,
    offMin, earlyMin, streakMin, brushMin, readMin, earnedMin, totalMin, maxMin: WEEKEND_MAX_MINUTES,
    weekdayBrushes, weekendBrushes, brushGate: BRUSH_GATE, brushGateMet, streakDays,
    usedMin: Math.floor(usedMs / MIN),
    leftMin: Math.floor(leftMs / MIN),
    // Only on a limited weekend: seconds of use left (for the lease), and whether it's all spent.
    secondsLeft: limited && isWeekend ? Math.floor(leftMs / 1000) : null,
    exhausted: limited && isWeekend && leftMs === 0,
  };
}

// The Books Shortcuts: "open" when Books opens, "close" when it closes. A closed
// session counts. An open with no close (a second open, or one older than
// READ_MAX_SESSION_MINUTES) is dropped, and so is a close with nothing open.
// state: { open: ms | null, sessions: [{ start, end }] } → { state, result, minutes }
export function readingEvent(prev, { now, event }) {
  const sessions = (prev?.sessions || []).filter(r => now - r.start < KEEP_DAYS * 86_400_000);
  const open = prev?.open ?? null;
  if (event === "open") {
    return { state: { open: now, sessions }, result: open === null ? "started" : "started (an earlier open never closed: dropped)", minutes: 0 };
  }
  const minutes = open === null ? 0 : Math.floor((now - open) / MIN);
  if (open === null) return { state: { open: null, sessions }, result: "no open session: nothing counted", minutes: 0 };
  if (now - open > READ_MAX_SESSION_MINUTES * MIN) {
    return { state: { open: null, sessions }, result: `dropped: open ${fmtHM(minutes)}, longer than ${fmtHM(READ_MAX_SESSION_MINUTES)}`, minutes: 0 };
  }
  return { state: { open: null, sessions: [...sessions, { start: open, end: now }] }, result: `counted ${fmtHM(minutes)}`, minutes };
}

// For the phone and the Mac: two or three readable lines.
export function weekendText(w) {
  if (!w.limited) {
    const first = dayFromKey(WEEKEND_POOL_FROM);
    return `Weekend time: one pool for Saturday and Sunday from the week of ${fmtDay(first)} (first weekend ${fmtDay(first + 5)}).`;
  }
  const parts = `  ${fmtHM(w.offMin)} off the Mac + ${fmtHM(w.earlyMin)} early nights + ${fmtHM(w.streakMin)} streaks + ${fmtHM(w.brushMin)} brushing + ${fmtHM(w.readMin)} reading`;
  const gate = w.brushGateMet
    ? `  brushing ${w.weekdayBrushes} of ${w.brushGate} needed Mon–Fri: done`
    : `  brushing ${w.weekdayBrushes} of ${w.brushGate} needed Mon–Fri: no weekend time until ${w.brushGate}`;
  if (w.isWeekend) {
    if (!w.brushGateMet) return [`Weekend time: none (${w.weekdayBrushes} of ${w.brushGate} brushes Mon–Fri)`, parts].join("\n");
    return [
      w.leftMin > 0 ? `Weekend time: ${fmtHM(w.leftMin)} left` : `Weekend time: all used up`,
      `  used ${fmtHM(w.usedMin)} of ${fmtHM(w.totalMin)} (at most ${fmtHM(w.maxMin)})`,
      parts,
    ].join("\n");
  }
  const banked = w.brushGateMet ? fmtHM(w.totalMin) : `0 (${fmtHM(Math.min(w.maxMin, w.earnedMin))} once you brush ${w.brushGate} times)`;
  return [`Weekend time banked for the weekend of ${fmtDay(w.saturdayDay)}: ${banked} (at most ${fmtHM(w.maxMin)})`, gate, parts].join("\n");
}
