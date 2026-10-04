// ─────────────────────────────────────────────────────────────────────────────
// Escalation to the accountability partner. Pure functions only.
//
// Out of workout compliance (no workout, no pass covering you):
//   1. a warning to you only, WARN_AFTER_HOURS after compliance ran out;
//   2. emails to both of you from PARTNER_AFTER_HOURS, then every PARTNER_REPEAT_HOURS,
//      until you're back in compliance;
//   3. back in compliance → your partner is told (if he was ever emailed).
// The clock runs from when compliance ran out and is never reset. The first
// day-pass request in a stretch holds the emails while it's pending; when it
// lapses or is cancelled, whatever is overdue goes out at the next check.
// Later requests in the same stretch don't hold anything.
// ─────────────────────────────────────────────────────────────────────────────

import { MIN, HOUR } from "./time.js";

export const WARN_AFTER_HOURS = 0;
export const PARTNER_AFTER_HOURS = 24;
export const PARTNER_REPEAT_HOURS = 24;
export const WARNING_LEAD_MINUTES = 60;   // the partner is never emailed sooner than this after your warning

// state: { since, warnedAt, partnerStep } | null
// input: { now, compliant, compliantUntil, requests: [{ at, pending }] }
// → { state, send: null | { kind: "warning"|"partner"|"back-on-track", to: "me"|"both", since, step } , holding }
export function escalate(prev, { now, compliant, compliantUntil, requests = [] }) {
  if (compliant) {
    const told = prev && prev.partnerStep > 0;
    return { state: null, send: told ? { kind: "back-on-track", to: "both", since: prev.since } : null, holding: false };
  }
  const st = prev ? { ...prev } : { since: compliantUntil ?? now, warnedAt: null, partnerStep: 0 };

  const first = requests.filter(r => r.at >= st.since).sort((a, b) => a.at - b.at)[0];
  if (first && first.pending) return { state: st, send: null, holding: true };

  const elapsed = now - st.since;
  if (!st.warnedAt) {
    if (elapsed < WARN_AFTER_HOURS * HOUR) return { state: st, send: null, holding: false };
    st.warnedAt = now;
    return { state: st, send: { kind: "warning", to: "me", since: st.since }, holding: false };
  }
  const due = elapsed < PARTNER_AFTER_HOURS * HOUR ? 0
    : 1 + Math.floor((elapsed - PARTNER_AFTER_HOURS * HOUR) / (PARTNER_REPEAT_HOURS * HOUR));
  if (due <= st.partnerStep || now - st.warnedAt < WARNING_LEAD_MINUTES * MIN) return { state: st, send: null, holding: false };
  st.partnerStep = due;
  return { state: st, send: { kind: "partner", to: "both", since: st.since, step: due }, holding: false };
}

// When will the partner first hear about this stretch? (for the warning email)
export const partnerFirstAt = (since, warnedAt) =>
  Math.max(since + PARTNER_AFTER_HOURS * HOUR, warnedAt + WARNING_LEAD_MINUTES * MIN);

// Shutdown alarm around vacations (Healthchecks check of the Mac daemon).
// While a vacation is active, and for VACATION_ALARM_SLACK_HOURS after it ends
// unless the Mac has checked in since, the server keeps the check green
// ("ping"). After that, if the Mac still hasn't checked in, it sends one "start"
// so the check's normal grace time applies again ("rearm").
// state: { rearmedFor } | null  → { action: "ping"|"rearm"|null, state }
export const VACATION_ALARM_SLACK_HOURS = 12;
const MAC_ALIVE_MINUTES = 10;

export function vacationAlarm(prev, { now, vacationActive, lastVacationEnd, macLastAt }) {
  if (vacationActive) return { action: "ping", state: prev };
  if (!lastVacationEnd || now < lastVacationEnd) return { action: null, state: prev };
  const macAlive = macLastAt && (macLastAt >= lastVacationEnd || now - macLastAt < MAC_ALIVE_MINUTES * MIN);
  if (macAlive) return { action: null, state: prev };
  if (prev?.rearmedFor === lastVacationEnd) return { action: null, state: prev };
  if (now < lastVacationEnd + VACATION_ALARM_SLACK_HOURS * HOUR) return { action: "ping", state: prev };
  return { action: "rearm", state: { rearmedFor: lastVacationEnd } };
}
