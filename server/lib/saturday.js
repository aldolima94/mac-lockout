// ─────────────────────────────────────────────────────────────────────────────
// The Saturday bank. Pure functions only: no Redis, no network, no clock reads.
//
// On Saturdays (São Paulo) MacBook time is only what you earned that week by
// staying off it: every minute Monday–Friday between 07:00 and the nightly
// lockout (22:00) that you aren't using the Mac earns a minute, up to 16 h.
// There's no base. Only time actually used on Saturday is spent (lib/usage.js);
// what's left is gone when the day ends. Saturdays before SATURDAY_BANK_FIRST
// have no limit.
// ─────────────────────────────────────────────────────────────────────────────

import { MIN, spDayNumber, mondayOf, weekdayOf, dayKey, dayFromKey, fmtDay, fmtHM } from "./time.js";
import { DAYTIME_FROM_HOUR, daytimeWindow, offMs } from "./usage.js";

export const SATURDAY_BANK_FIRST = "2026-11-07";    // the first Saturday with a limit
export const SATURDAY_MAX_MINUTES = 16 * 60;

// inputs: { now, policy, usage }
export function saturdayBank({ now, policy, usage = null }) {
  const today = spDayNumber(now);
  // On Sunday the coming week's Saturday is the one being earned.
  const monday = weekdayOf(today) === 0 ? today + 1 : mondayOf(today), saturday = monday + 5;
  const limited = saturday >= dayFromKey(SATURDAY_BANK_FIRST);

  let earnedMs = 0;
  for (let n = monday; n < saturday; n++) earnedMs += offMs(daytimeWindow(n, policy), now, usage?.used?.[dayKey(n)]?.daytime);
  const offMin = Math.floor(earnedMs / MIN);
  const totalMin = Math.min(SATURDAY_MAX_MINUTES, offMin);
  const usedMs = usage?.saturdays?.[dayKey(saturday)] || 0;
  const isSaturday = today === saturday;
  const leftMs = Math.max(0, totalMin * MIN - usedMs);

  return {
    saturday: dayKey(saturday), saturdayDay: saturday, limited, isSaturday,
    offMin, totalMin, maxMin: SATURDAY_MAX_MINUTES,
    window: `${pad(DAYTIME_FROM_HOUR)}:00–${pad(policy.nightStartHourSP)}:00`,
    usedMin: Math.floor(usedMs / MIN),
    leftMin: Math.floor(leftMs / MIN),
    // Only on a limited Saturday: seconds of use left (for the lease), and whether it's all spent.
    secondsLeft: limited && isSaturday ? Math.floor(leftMs / 1000) : null,
    exhausted: limited && isSaturday && leftMs === 0,
  };
}
const pad = n => String(n).padStart(2, "0");

// For the phone and the Mac: two or three readable lines.
export function saturdayText(s) {
  const day = fmtDay(s.saturdayDay);
  if (!s.limited) return `Saturday time: no limit this Saturday (${day}). The Saturday limit starts ${fmtDay(dayFromKey(SATURDAY_BANK_FIRST))}.`;
  const how = `  a minute for each minute off the Mac, Mon–Fri ${s.window} (at most ${fmtHM(s.maxMin)})`;
  if (s.isSaturday) {
    return [
      s.leftMin > 0 ? `Saturday time today: ${fmtHM(s.leftMin)} left` : `Saturday time today: all used up`,
      `  used ${fmtHM(s.usedMin)} of ${fmtHM(s.totalMin)}`,
    ].join("\n");
  }
  return [`Saturday time banked for ${day}: ${fmtHM(s.totalMin)}`, how].join("\n");
}
