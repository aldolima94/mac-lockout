import { test } from "node:test";
import assert from "node:assert/strict";
import { escalate, vacationAlarm, PARTNER_AFTER_HOURS } from "../lib/escalation.js";
import { trackInUse, HOUR, MIN } from "../lib/rules.js";

const T = Date.parse("2026-10-05T12:00:00Z");

// Run the scheduler every 5 minutes from `from` to `to`; collect what it sends.
function run(state, from, to, input = () => ({})) {
  const sent = [];
  for (let now = from; now <= to; now += 5 * MIN) {
    const r = escalate(state, { now, compliant: false, compliantUntil: T, ...input(now) });
    state = r.state;
    if (r.send) sent.push({ h: Math.round((now - T) / HOUR * 10) / 10, kind: r.send.kind, to: r.send.to });
  }
  return { state, sent };
}

test("warning to you first, partner at 24 h, then every 24 h", () => {
  const { state, sent } = run(null, T + MIN, T + 73 * HOUR);
  assert.deepEqual(sent, [
    { h: 0, kind: "warning", to: "me" },
    { h: 24, kind: "partner", to: "both" },
    { h: 48, kind: "partner", to: "both" },
    { h: 72, kind: "partner", to: "both" },
  ]);
  const back = escalate(state, { now: T + 74 * HOUR, compliant: true });
  assert.equal(back.state, null);
  assert.deepEqual([back.send.kind, back.send.to], ["back-on-track", "both"]);
});

test("back in compliance before the partner heard anything → no email to him", () => {
  const { state } = run(null, T + MIN, T + 5 * HOUR);
  assert.equal(escalate(state, { now: T + 6 * HOUR, compliant: true }).send, null);
});

test("a pending request holds escalation without resetting the clock", () => {
  let { state } = run(null, T + MIN, T + 2 * HOUR);                    // warned
  const req = { at: T + 20 * HOUR, pending: true };
  let r = run(state, T + 20 * HOUR, T + 26 * HOUR, () => ({ requests: [req] }));
  assert.deepEqual(r.sent, []);                                         // 24 h passed, held
  req.pending = false;                                                  // it lapsed
  r = run(r.state, T + 26 * HOUR + 5 * MIN, T + 27 * HOUR, () => ({ requests: [req] }));
  assert.deepEqual(r.sent, [{ h: 26.1, kind: "partner", to: "both" }]); // overdue email goes out at once
});

test("only the first request in a stretch holds; a second one doesn't", () => {
  const { state } = run(null, T + MIN, T + 2 * HOUR);
  const requests = [{ at: T + 3 * HOUR, pending: false }, { at: T + 23 * HOUR, pending: true }];
  const r = run(state, T + 23 * HOUR, T + 25 * HOUR, () => ({ requests }));
  assert.deepEqual(r.sent.map(x => x.kind), ["partner"]);
});

test("partner never hears before you've had an hour's warning", () => {
  // scheduler was down: first check happens 30 h into the stretch
  const r = run(null, T + 30 * HOUR, T + 32 * HOUR);
  assert.deepEqual(r.sent, [{ h: 30, kind: "warning", to: "me" }, { h: 31, kind: "partner", to: "both" }]);
  assert.equal(PARTNER_AFTER_HOURS, 24);
});

test("in-use while denied: first email to you, later ones to both", () => {
  let st = null; const to = [];
  for (let t = T; t < T + 70 * MIN; t += 10_000) {
    const r = trackInUse(st, { now: t, allowed: false, userPresent: true });
    st = r.state; if (r.sendAlert) to.push(r.to);
  }
  assert.deepEqual(to, ["me", "both", "both"]);
});

test("vacation shutdown alarm: quiet during and 12 h after, then re-armed once", () => {
  const end = T + 5 * 24 * HOUR;
  const macOff = T - HOUR;
  assert.equal(vacationAlarm(null, { now: T + HOUR, vacationActive: true, lastVacationEnd: end, macLastAt: macOff }).action, "ping");
  assert.equal(vacationAlarm(null, { now: end + 11 * HOUR, vacationActive: false, lastVacationEnd: end, macLastAt: macOff }).action, "ping");
  const r = vacationAlarm(null, { now: end + 12 * HOUR, vacationActive: false, lastVacationEnd: end, macLastAt: macOff });
  assert.equal(r.action, "rearm");
  assert.equal(vacationAlarm(r.state, { now: end + 13 * HOUR, vacationActive: false, lastVacationEnd: end, macLastAt: macOff }).action, null);
  // Mac came back after the vacation → nothing special
  assert.equal(vacationAlarm(null, { now: end + 2 * HOUR, vacationActive: false, lastVacationEnd: end, macLastAt: end + HOUR }).action, null);
  assert.equal(vacationAlarm(null, { now: T, vacationActive: false, lastVacationEnd: null, macLastAt: macOff }).action, null);
});
