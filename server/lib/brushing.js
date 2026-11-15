// The daily brushing rule: each day the Mac stays locked until you've brushed.
// A brush counts for the São Paulo calendar day it started in, and must last
// BRUSH.minMinutes (2 min), like every other brushing rule. It only counts
// once the Brushing Shortcut has sent it, so it has to reach Health and then
// the server before the Mac unlocks (within a minute of the server having it).
// Pure: no Redis, no clock reads.

import { spDayNumber, spAt, dayFromKey, iso, MIN } from "./time.js";
import { BRUSH } from "./sunday.js";

// The first day the rule applies (from 00:00 São Paulo). Must be after the merge.
export const BRUSH_DAILY_FROM = spAt(dayFromKey("2026-11-16"));

// inputs: now (ms), brushes: [{ start, end }]
export function dailyBrushing(now, brushes = []) {
  const today = spDayNumber(now);
  let first = null;
  for (const b of brushes || []) {
    const start = Date.parse(b.start), end = Date.parse(b.end);
    if (isNaN(start) || isNaN(end) || start > now || end - start < BRUSH.minMinutes * MIN) continue;
    if (spDayNumber(start) === today && (first === null || start < first)) first = start;
  }
  const active = now >= BRUSH_DAILY_FROM;
  return {
    active,                          // the rule applies today
    brushed: first !== null,         // a brush today has reached the server
    met: !active || first !== null,  // nothing stops the Mac on brushing grounds
    firstBrushToday: iso(first),
    from: iso(BRUSH_DAILY_FROM),
  };
}
