// ─────────────────────────────────────────────────────────────────────────────
// The Sunday bank. Pure functions only: no Redis, no network, no clock reads.
//
// On Sundays (São Paulo) MacBook time is a budget: sundayBaseHours (4 h) plus
// what you earned that week, Monday–Sunday (São Paulo):
//   • brushing: each session of ≥ 2 min earns 30 min, at most 2 sessions a day;
//   • workout streaks: the 2nd day in a row with a qualifying workout earns 1 h,
//     and each further day in a row another 1 h (counting restarts each Monday);
//   • early nights: each night Monday–Saturday with nobody at the Mac in the
//     hour before the nightly lockout (21:00–22:00) earns 1 h.
// Only time actually logged in on Sunday is spent, whenever it happens. What's
// left is gone when the week ends. Sundays before SUNDAY_BANK_FIRST have no limit.
// ─────────────────────────────────────────────────────────────────────────────

import { MIN, spDayNumber, spClock, spAt, mondayOf, dayKey, dayFromKey, fmtDay, fmtHM } from "./time.js";

export const SUNDAY_BANK_FIRST = "2026-10-25";      // the first Sunday with a limit
export const BRUSH = { minMinutes: 2, earnMinutes: 30, perDay: 2 };
export const STREAK_EARN_MINUTES = 60;
export const EARLY_NIGHT_EARN_MINUTES = 60;
// Two Mac check-ins further apart than this: it was asleep in between, so the gap isn't counted.
export const USAGE_MAX_GAP_SECONDS = 150;
const KEEP_DAYS = 21;

// The hour before the nightly lockout, on day n: "using the Mac late" if you're at it then.
const lateHour = policy => policy.nightStartHourSP - 1;

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

  // Early nights: Monday–Saturday nights that are over, with nobody at the Mac in the last hour.
  const late = new Set(usage?.lateNights || []);
  let earlyNights = 0;
  for (let n = monday; n < sunday; n++) {
    if (now >= spAt(n, policy.nightStartHourSP) && !late.has(dayKey(n))) earlyNights++;
  }

  const baseMin = policy.sundayBaseHours * 60;
  const brushMin = brushSessions * BRUSH.earnMinutes;
  const streakMin = streakDays * STREAK_EARN_MINUTES;
  const earlyMin = earlyNights * EARLY_NIGHT_EARN_MINUTES;
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

// Called on every Mac check-in. `last` is the previous check-in { at, userPresent }.
// counting: today is a limited Sunday and the Mac was allowed.
// state: { sundays: { "2026-10-25": ms }, lateNights: ["2026-10-19", …] } → new state
export function trackUsage(prev, { now, userPresent, last, counting, policy }) {
  const today = spDayNumber(now);
  const st = { sundays: { ...(prev?.sundays || {}) }, lateNights: [...(prev?.lateNights || [])] };

  // Sunday minutes: the time since the last check-in, if you were at the screen
  // both times and the Mac didn't sleep in between.
  if (counting && userPresent && last?.userPresent && last.at < now &&
      now - last.at <= USAGE_MAX_GAP_SECONDS * 1000 && spDayNumber(last.at) === today) {
    const k = dayKey(today);
    st.sundays[k] = (st.sundays[k] || 0) + (now - last.at);
  }

  // At the Mac in the hour before the lockout → no early-night hour for today.
  if (userPresent && spClock(now).h === lateHour(policy) && !st.lateNights.includes(dayKey(today))) {
    st.lateNights.push(dayKey(today));
  }

  const oldest = dayKey(today - KEEP_DAYS);
  for (const k of Object.keys(st.sundays)) if (k < oldest) delete st.sundays[k];
  st.lateNights = st.lateNights.filter(k => k >= oldest);
  return st;
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
