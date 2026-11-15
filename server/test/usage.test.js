// What counts as using the Mac, and the 25-minute workout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, detectSessions, effectivePolicy, minDurationFor, MIN, HOUR } from "../lib/rules.js";
import { weekendBank } from "../lib/weekend.js";
import { trackUsage, isUsing } from "../lib/usage.js";

// São Paulo wall-clock time → ms (UTC-3 all year).  sp("2026-11-16 08:00")
const sp = s => Date.parse(`${s.replace(" ", "T")}:00-03:00`);
const policy = effectivePolicy(null, 0);

// The Mac checking in once a minute from `from` to `to` (São Paulo, same day).
// check(t) → { userPresent, idleSeconds }; default: using it.
function useMac(u, from, to, check = () => ({ userPresent: true, idleSeconds: 0 }), spending = false) {
  let last = null;
  for (let t = sp(from); t <= sp(to); t += MIN) {
    const c = check(t);
    u = trackUsage(u, { now: t, ...c, last, spending, policy });
    last = { at: t, ...c };
  }
  return u;
}
// Minutes off the Mac earned so far this week (Mon Nov 16 onward: 10:00–22:00).
const off = (now, usage) => weekendBank({ now, policy, usage }).offMin;

test("using = a screen on and touched in the last 2 minutes (or a video playing)", () => {
  assert.equal(isUsing({ userPresent: true, idleSeconds: 0 }), true);      // typing, or a video (the Mac sends 0)
  assert.equal(isUsing({ userPresent: true, idleSeconds: 119 }), true);
  assert.equal(isUsing({ userPresent: true, idleSeconds: 120 }), false);   // walked away, screen still lit
  assert.equal(isUsing({ userPresent: false, idleSeconds: 0 }), false);    // logged out, or every screen off
  assert.equal(isUsing({ userPresent: true }), true);                      // an older daemon: no idle time
  assert.equal(isUsing(null), false);
});

test("a screen left lit after you walk away isn't use; a video is", () => {
  // Monday 21:00–22:00 (12 h window, 720 min): touched it last at 21:10, the screen stayed on until 21:40.
  let u = useMac(null, "2026-11-16 21:00", "2026-11-16 21:40", t => ({ userPresent: true, idleSeconds: Math.max(0, (t - sp("2026-11-16 21:10")) / 1000) }));
  // Use: 21:00 until the check-in where it had been idle under 2 minutes (21:11) → 11 minutes.
  assert.equal(off(sp("2026-11-16 22:00"), u), 720 - 11);
  // A movie 21:00–21:40 (the Mac reports idle 0 while a video keeps the screen on).
  u = useMac(null, "2026-11-16 21:00", "2026-11-16 21:40");
  assert.equal(off(sp("2026-11-16 22:00"), u), 720 - 40);
  // Lid closed with a few-second dark wake: the daemon reports nobody there.
  u = useMac(null, "2026-11-16 21:15", "2026-11-16 21:16", () => ({ userPresent: false, idleSeconds: 0 }));
  assert.equal(off(sp("2026-11-16 22:00"), u), 720);
});

test("workouts: 25 minutes from Nov 1 (São Paulo); 20 before", () => {
  // A workout of `minutes` at 130 bpm, starting at São Paulo time `start`.
  const w = (start, minutes) => detectSessions(Array.from({ length: minutes * 2 + 1 }, (_, i) => ({ t: new Date(sp(start) + i * 30_000).toISOString(), bpm: 130 })))[0];
  assert.equal(w("2026-10-31 10:00", 22).pass, true);
  assert.equal(w("2026-10-31 23:50", 22).pass, true);     // started Saturday night, ends after midnight
  assert.equal(w("2026-11-01 00:00", 22).pass, false);
  assert.equal(w("2026-11-02 10:00", 22).pass, false);
  assert.equal(w("2026-11-02 10:00", 24).pass, false);
  assert.equal(w("2026-11-02 10:00", 25).pass, true);
  assert.equal(minDurationFor(sp("2026-10-31 23:59")), 20);
  assert.equal(minDurationFor(sp("2026-11-01 00:00")), 25);
  // A 22-minute workout on Oct 31 keeps you compliant for its 48 h, across Nov 1.
  const d = decide({ now: sp("2026-11-02 09:00"), sessions: [w("2026-10-31 10:00", 22)] });
  assert.equal(d.compliance.compliant, true);
});

test("the warning email says 25 minutes from Nov 1, 20 before", async () => {
  const { warning } = await import("../lib/messages.js");
  const text = now => warning({ now, since: now - HOUR, partnerAt: now + HOUR, partnerName: "Aldo", dayLeft: 2 }).text;
  assert.match(text(sp("2026-10-31 12:00")), /\(≥20 min with ≥5 min above 120 bpm\)/);
  assert.match(text(sp("2026-11-01 12:00")), /\(≥25 min with ≥5 min above 120 bpm\)/);
});
