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
//   • sundays / saturdays: use on a limited Sunday or Saturday (what the banks spend);
//   • used.daytime: use between 07:00 and the nightly lockout (the Saturday bank);
//   • used.lastHour: use in the hour before the nightly lockout (the Sunday bank).
// The banks turn the rest of those windows into minutes earned for being off the Mac.
// ─────────────────────────────────────────────────────────────────────────────

import { spDayNumber, spClock, spAt, weekdayOf, dayKey, dayFromKey } from "./time.js";

// Weeks from this Monday earn by the minute; before it, an early night was a whole hour or nothing.
export const EARN_BY_MINUTE_FROM = "2026-11-02";
// Touched within this long (or a video playing) and a screen on = using the Mac.
export const IDLE_LIMIT_SECONDS = 120;
// Two Mac check-ins further apart than this: it was asleep in between, so the gap isn't counted.
export const USAGE_MAX_GAP_SECONDS = 150;
export const DAYTIME_FROM_HOUR = 7;
const KEEP_DAYS = 21;

// A check-in { userPresent, idleSeconds }: is someone using the Mac? Older daemons send no idle time.
export const isUsing = c => Boolean(c?.userPresent) && (Number(c.idleSeconds) || 0) < IDLE_LIMIT_SECONDS;

// The earning windows on day n, as [start, end) timestamps.
const lateHour = policy => policy.nightStartHourSP - 1;
export const daytimeWindow = (n, policy) => [spAt(n, DAYTIME_FROM_HOUR), spAt(n, policy.nightStartHourSP)];
export const lastHourWindow = (n, policy) => [spAt(n, lateHour(policy)), spAt(n, policy.nightStartHourSP)];

// ms off the Mac in a window by `now`: the part that has passed, less what was use.
export const offMs = ([a, b], now, usedMs = 0) => Math.max(0, Math.min(b, now) - a - (usedMs || 0));
const overlap = (a, b, [s, e]) => Math.max(0, Math.min(b, e) - Math.max(a, s));

// Called on every Mac check-in. `last` is the previous check-in { at, userPresent, idleSeconds }.
// spending: today is a limited Saturday or Sunday and the Mac was allowed.
// state: { sundays: { day: ms }, saturdays: { day: ms }, used: { day: { daytime, lastHour } }, lateNights: [day] }
export function trackUsage(prev, { now, userPresent, idleSeconds = 0, last, spending, policy }) {
  const today = spDayNumber(now), k = dayKey(today);
  const st = {
    sundays: { ...(prev?.sundays || {}) }, saturdays: { ...(prev?.saturdays || {}) },
    used: { ...(prev?.used || {}) }, lateNights: [...(prev?.lateNights || [])],
  };

  // The time since the last check-in is use if you were using the Mac both times
  // and it didn't sleep in between.
  if (isUsing({ userPresent, idleSeconds }) && isUsing(last) && last.at < now &&
      now - last.at <= USAGE_MAX_GAP_SECONDS * 1000 && spDayNumber(last.at) === today) {
    if (spending) {
      const spent = weekdayOf(today) === 6 ? st.saturdays : st.sundays;
      spent[k] = (spent[k] || 0) + (now - last.at);
    }
    const daytime = overlap(last.at, now, daytimeWindow(today, policy));
    const lastHour = overlap(last.at, now, lastHourWindow(today, policy));
    if (daytime || lastHour) {
      const d = st.used[k] || { daytime: 0, lastHour: 0 };
      st.used[k] = { daytime: d.daytime + daytime, lastHour: d.lastHour + lastHour };
    }
  }

  // Weeks before EARN_BY_MINUTE_FROM: used the Mac in the hour before the lockout → no
  // early-night hour for that day. "Used" is when you last touched it.
  const lastUse = now - Math.max(0, Number(idleSeconds) || 0) * 1000;
  if (today < dayFromKey(EARN_BY_MINUTE_FROM) && userPresent && spDayNumber(lastUse) === today &&
      spClock(lastUse).h === lateHour(policy) && !st.lateNights.includes(k)) {
    st.lateNights.push(k);
  }

  const oldest = dayKey(today - KEEP_DAYS);
  for (const m of [st.sundays, st.saturdays, st.used]) for (const d of Object.keys(m)) if (d < oldest) delete m[d];
  st.lateNights = st.lateNights.filter(d => d >= oldest);
  return st;
}
