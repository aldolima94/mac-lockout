// The daily brushing rule: each day the Mac stays locked until you've brushed.
// A brush counts for the São Paulo calendar day it started in, and must last
// BRUSH.minMinutes (2 min), like every other brushing rule. It only counts
// once the Brushing Shortcut has sent it, so it has to reach Health and then
// the server before the Mac unlocks (within a minute of the server having it).
// Pure: no Redis, no clock reads.

import { spDayNumber, spAt, dayFromKey, iso, MIN } from "./time.js";

// What counts as a brush, and what one earns for the weekend (lib/weekend.js).
export const BRUSH = { minMinutes: 2, earnMinutes: 30, perDay: 2 };
const KEEP_DAYS = 21;

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
