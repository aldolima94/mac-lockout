// ─────────────────────────────────────────────────────────────────────────────
// The Sunday bank. Pure functions only: no Redis, no network, no clock reads.
//
// On Sundays (São Paulo) MacBook time is a budget: sundayBaseHours (4 h) plus
// what you earned that week, Monday–Sunday (São Paulo):
//   • brushing: each session of ≥ 2 min earns 30 min, at most 2 sessions a day;
//   • workout streaks: the 2nd day in a row with a qualifying workout earns 1 h,
//     and each further day in a row another 1 h (counting restarts each Monday);
//   • early nights: every minute Monday–Saturday in the hour before the nightly
//     lockout (21:00–22:00) that you aren't using the Mac earns a minute. Weeks
//     before EARN_BY_MINUTE_FROM: each night with nobody at the Mac then earned 1 h.
// Only time actually used on Sunday is spent, whenever it happens (lib/usage.js).
// What's left is gone when the week ends. Sundays before SUNDAY_BANK_FIRST have no limit.
// ─────────────────────────────────────────────────────────────────────────────

import { MIN, spDayNumber, spAt, mondayOf, dayKey, dayFromKey, fmtDay, fmtHM } from "./time.js";
import { EARN_BY_MINUTE_FROM, lastHourWindow, offMs } from "./usage.js";

export const SUNDAY_BANK_FIRST = "2026-10-25";      // the first Sunday with a limit
export const BRUSH = { minMinutes: 2, earnMinutes: 30, perDay: 2 };
export const STREAK_EARN_MINUTES = 60;
export const EARLY_NIGHT_EARN_MINUTES = 60;         // weeks before EARN_BY_MINUTE_FROM
const KEEP_DAYS = 21;

// inputs: { now, policy, workoutEnds: [ms], brushes: [{ start, end }], usage }
export function sundayBank({ now, policy, workoutEnds = [], brushes = [], usage = null }) {
  const today = spDayNumber(now);
  const monday = mondayOf(today), sunday = monday + 6;
  const limited = sunday >= dayFromKey(SUNDAY_BANK_FIRST);

  // Brushing: sessions of ≥ 2 min, by São Paulo day, at most 2 a day.
  const perDay = {};
  for (const b of brushes || []) {
    const start = Date.parse(b.start), end = Date.parse(b.end);
    if (isNaN(start) || isNaN(end) || start > now || end - start < BRUSH.minMinutes * MIN) continue;
    const n = spDayNumber(start);
    if (n >= monday && n <= sunday) perDay[n] = (perDay[n] || 0) + 1;
  }
  const brushSessions = Object.values(perDay).reduce((a, c) => a + Math.min(c, BRUSH.perDay), 0);

  // Workout streaks: every day that continues a run of workout days earns.
  const workoutDays = new Set(workoutEnds.filter(t => t <= now).map(spDayNumber));
  let streakDays = 0, run = 0;
  for (let n = monday; n <= Math.min(today, sunday); n++) {
    run = workoutDays.has(n) ? run + 1 : 0;
    if (run >= 2) streakDays++;
  }

  // Early nights, Monday–Saturday: the minutes of the last hour you weren't using the Mac.
  // Older weeks: whole nights that are over, with nobody at the Mac in the last hour.
  let earlyMs = 0, earlyNights = null;
  if (monday >= dayFromKey(EARN_BY_MINUTE_FROM)) {
    for (let n = monday; n < sunday; n++) earlyMs += offMs(lastHourWindow(n, policy), now, usage?.used?.[dayKey(n)]?.lastHour);
  } else {
    const late = new Set(usage?.lateNights || []);
    earlyNights = 0;
    for (let n = monday; n < sunday; n++) {
      if (now >= spAt(n, policy.nightStartHourSP) && !late.has(dayKey(n))) earlyNights++;
    }
    earlyMs = earlyNights * EARLY_NIGHT_EARN_MINUTES * MIN;
  }

  const baseMin = policy.sundayBaseHours * 60;
  const brushMin = brushSessions * BRUSH.earnMinutes;
  const streakMin = streakDays * STREAK_EARN_MINUTES;
  const earlyMin = Math.floor(earlyMs / MIN);
  const totalMin = baseMin + brushMin + streakMin + earlyMin;
  const usedMs = usage?.sundays?.[dayKey(sunday)] || 0;
  const isSunday = today === sunday;
  const leftMs = Math.max(0, totalMin * MIN - usedMs);

  return {
    sunday: dayKey(sunday), sundayDay: sunday, limited, isSunday,
    baseMin, brushMin, streakMin, earlyMin, totalMin,
    brushSessions, streakDays, earlyNights,
    usedMin: Math.floor(usedMs / MIN),
    leftMin: Math.floor(leftMs / MIN),
    // Only on a limited Sunday: seconds of use left (for the lease), and whether it's all spent.
    secondsLeft: limited && isSunday ? Math.floor(leftMs / 1000) : null,
    exhausted: limited && isSunday && leftMs === 0,
  };
}

// The brushing Shortcut re-sends the last few days, so the same session arrives
// more than once. Sessions starting within a minute of each other are the same one.
export function mergeBrushes(existing, found, now) {
  const all = [...(existing || [])];
  for (const b of found) {
    const s = Date.parse(b.start), e = Date.parse(b.end);
    if (isNaN(s) || isNaN(e) || e < s) continue;
    const x = { start: new Date(s).toISOString(), end: new Date(e).toISOString() };
    const i = all.findIndex(y => Math.abs(Date.parse(y.start) - s) < MIN);
    if (i === -1) all.push(x);
    else if (e - s > Date.parse(all[i].end) - Date.parse(all[i].start)) all[i] = x;
  }
  return all
    .filter(x => now - Date.parse(x.start) < KEEP_DAYS * 86_400_000)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

// For the phone and the Mac: two or three readable lines.
export function sundayText(s) {
  const day = fmtDay(s.sundayDay);
  if (!s.limited) return `Sunday time: no limit this Sunday (${day}). The Sunday limit starts ${fmtDay(dayFromKey(SUNDAY_BANK_FIRST))}.`;
  const parts = `  ${fmtHM(s.baseMin)} base + ${fmtHM(s.brushMin)} brushing + ${fmtHM(s.streakMin)} streaks + ${fmtHM(s.earlyMin)} early nights`;
  if (s.isSunday) {
    return [
      s.leftMin > 0 ? `Sunday time today: ${fmtHM(s.leftMin)} left` : `Sunday time today: all used up`,
      `  used ${fmtHM(s.usedMin)} of ${fmtHM(s.totalMin)}`,
      parts,
    ].join("\n");
  }
  return [`Sunday time banked for ${day}: ${fmtHM(s.totalMin)}`, parts].join("\n");
}
