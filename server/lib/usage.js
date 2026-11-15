// ─────────────────────────────────────────────────────────────────────────────
// Time at the Mac. Pure functions only: no Redis, no network, no clock reads.
//
// The Mac checks in about once a minute. The stretch between two check-ins is
// use when both say you're using it: logged in, a screen on, and you touched the
// keyboard or trackpad in the last 2 minutes (or a video is keeping the screen
// on). A Mac that's asleep, shut down or out of reach doesn't check in, so that
// time is never use.
//
// Recorded per São Paulo day:
//   • saturdays / sundays: use on a limited weekend day (what the weekend pool spends);
//   • used.daytime: use between 10:00 (08:00 before NEW_RULES_FROM) and the
//     nightly lockout. The weekend pool (lib/weekend.js) turns the rest of that
//     window, Monday–Friday, into minutes earned for being off the Mac.
//   • used.lastHour: use 21:00–22:00, recorded only up to the week of Nov 9 2026
//     (its early nights).
// ─────────────────────────────────────────────────────────────────────────────

import { spDayNumber, spAt, weekdayOf, dayKey, dayFromKey } from "./time.js";

// Touched within this long (or a video playing) and a screen on = using the Mac.
export const IDLE_LIMIT_SECONDS = 120;
// Two Mac check-ins further apart than this: it was asleep in between, so the gap isn't counted.
export const USAGE_MAX_GAP_SECONDS = 150;
// Weeks from this Monday earn into one weekend pool (lib/weekend.js).
export const WEEKEND_POOL_FROM = "2026-11-09";
// Weeks from this Monday: off the Mac counts from 10:00, and nothing earns twice
// (no early nights, no brushing gate or bonus). The week of Nov 9 keeps its rules.
export const NEW_RULES_FROM = "2026-11-16";
export const DAYTIME_FROM_HOUR = 10;
export const daytimeFromHour = n => (n >= dayFromKey(NEW_RULES_FROM) ? DAYTIME_FROM_HOUR : 8);
const KEEP_DAYS = 21;

// A check-in { userPresent, idleSeconds }: is someone using the Mac? Older daemons send no idle time.
export const isUsing = c => Boolean(c?.userPresent) && (Number(c.idleSeconds) || 0) < IDLE_LIMIT_SECONDS;

// The earning windows on day n, as [start, end) timestamps.
export const daytimeWindow = (n, policy) => [spAt(n, daytimeFromHour(n)), spAt(n, policy.nightStartHourSP)];
// The hour before the lockout: the week of Nov 9's early nights only.
export const lastHourWindow = (n, policy) => [spAt(n, policy.nightStartHourSP - 1), spAt(n, policy.nightStartHourSP)];

// ms off the Mac in a window by `now`: the part that has passed, less what was use.
export const offMs = ([a, b], now, usedMs = 0) => Math.max(0, Math.min(b, now) - a - (usedMs || 0));
const overlap = (a, b, [s, e]) => Math.max(0, Math.min(b, e) - Math.max(a, s));

// Called on every Mac check-in. `last` is the previous check-in { at, userPresent, idleSeconds }.
// spending: today is a limited weekend day and the Mac was allowed.
// state: { saturdays: { day: ms }, sundays: { day: ms }, used: { day: { daytime, lastHour? } } }
export function trackUsage(prev, { now, userPresent, idleSeconds = 0, last, spending, policy }) {
  const today = spDayNumber(now), k = dayKey(today);
  const st = { saturdays: { ...(prev?.saturdays || {}) }, sundays: { ...(prev?.sundays || {}) }, used: { ...(prev?.used || {}) } };

  // The time since the last check-in is use if you were using the Mac both times
  // and it didn't sleep in between.
  if (isUsing({ userPresent, idleSeconds }) && isUsing(last) && last.at < now &&
      now - last.at <= USAGE_MAX_GAP_SECONDS * 1000 && spDayNumber(last.at) === today) {
    if (spending) {
      const spent = weekdayOf(today) === 6 ? st.saturdays : st.sundays;
      spent[k] = (spent[k] || 0) + (now - last.at);
    }
    const daytime = overlap(last.at, now, daytimeWindow(today, policy));
    // The hour before the lockout only matters to the week of Nov 9 (early nights).
    const lastHour = today < dayFromKey(NEW_RULES_FROM) ? overlap(last.at, now, lastHourWindow(today, policy)) : 0;
    if (daytime || lastHour) {
      const d = st.used[k] || { daytime: 0 };
      st.used[k] = { ...d, daytime: d.daytime + daytime, ...(lastHour && { lastHour: (d.lastHour || 0) + lastHour }) };
    }
  }

  const oldest = dayKey(today - KEEP_DAYS);
  for (const m of [st.saturdays, st.sundays, st.used]) for (const d of Object.keys(m)) if (d < oldest) delete m[d];
  return st;
}
