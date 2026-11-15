import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../lib/rules.js";
import { dailyBrushing, BRUSH_DAILY_FROM } from "../lib/brushing.js";

const MIN = 60_000, HOUR = 60 * MIN;
const sp = s => Date.parse(`${s}-03:00`);                     // São Paulo local time
const brush = (start, minutes = 2.5) => ({ start: new Date(sp(start)).toISOString(), end: new Date(sp(start) + minutes * MIN).toISOString() });
// A workout that keeps the workout rule satisfied around `now`.
const workout = now => [{ start: new Date(now - 3 * HOUR).toISOString(), end: new Date(now - 2 * HOUR).toISOString(), durationMin: 30, elevatedMin: 20, satisfactory: true }];
const run = (now, brushes, extra = {}) => decide({ now, policyState: null, sessions: workout(now), passes: [], brushes, ...extra });

test("the rule starts Mon Nov 16 2026 at 00:00 São Paulo", () => {
  assert.equal(new Date(BRUSH_DAILY_FROM).toISOString(), "2026-11-16T03:00:00.000Z");
  assert.equal(dailyBrushing(sp("2026-11-15T10:00:00"), []).met, true);
  assert.equal(dailyBrushing(sp("2026-11-16T10:00:00"), []).met, false);
});

test("no brush today → locked with not_brushed_today; a brush today unlocks", () => {
  const now = sp("2026-11-17T09:00:00");
  const d0 = run(now, []);
  assert.equal(d0.compliance.compliant, true, "workout rule satisfied in this test");
  assert.deepEqual([d0.allowed, d0.reason], [false, "not_brushed_today"]);
  const d1 = run(now, [brush("2026-11-17T08:10:00")]);
  assert.deepEqual([d1.allowed, d1.reason], [true, null]);
  assert.equal(d1.brushing.firstBrushToday, new Date(sp("2026-11-17T08:10:00")).toISOString());
});

test("last night's brush, a short brush, and a future brush don't count", () => {
  const now = sp("2026-11-17T09:00:00");
  assert.equal(run(now, [brush("2026-11-16T23:59:00")]).reason, "not_brushed_today");
  assert.equal(run(now, [brush("2026-11-17T08:10:00", 1.5)]).reason, "not_brushed_today");
  assert.equal(run(now, [brush("2026-11-17T09:30:00")]).reason, "not_brushed_today");
  assert.equal(run(now, [brush("2026-11-17T00:01:00")]).allowed, true, "after midnight is today");
});

test("the nightly lockout still comes first; passes don't cover brushing", () => {
  assert.equal(run(sp("2026-11-17T05:00:00"), []).reason, "nightly_lockout");
  const now = sp("2026-11-17T09:00:00");
  const pass = [{ kind: "day", status: "confirmed", requestedAt: now - 3 * HOUR, confirmedAt: now - 2 * HOUR, activatesAt: now - HOUR, endsAt: now + 20 * HOUR }];
  const d = decide({ now, policyState: null, sessions: [], passes: pass, brushes: [] });
  assert.equal(d.reason, "not_brushed_today");
});

test("the dev override still unlocks", () => {
  const now = sp("2026-11-17T09:00:00");
  const d = run(now, [], { devRecovery: true, override: { until: now + HOUR } });
  assert.equal(d.allowed, true);
  assert.equal(d.devOverride.wouldOtherwiseBe.reason, "not_brushed_today");
});
