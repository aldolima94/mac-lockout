// /api/pass — your passes, from the phone. Key: USER_KEY (or ADMIN_KEY). GET or POST.
//
//   (no action)                              passes left, what's pending or scheduled
//   ?action=day&reason=sick                  request a day pass (only while out of compliance)
//   ?action=cancel-day                       cancel the day pass in progress (before it activates)
//   ?action=vacation&start=2026-12-20        schedule a vacation (midnight New York; or 2026-12-20T08:00 NY time)
//   ?action=move-vacation&start=2026-12-22   move it (before it starts)
//   ?action=cancel-vacation                  cancel it (before it starts)
//
// Add &format=text for a plain-text answer (what the iPhone Shortcuts show).

import { decide, effectivePolicy, satisfactoryEnds } from "../lib/rules.js";
import {
  requestDayPass, cancelDayPass, scheduleVacation, moveVacation, cancelVacation, summaryForApi,
} from "../lib/passes.js";
import { fmtNY, parseStart } from "../lib/time.js";
import { redis, K, hasKey, deny, readBody, loadState, logEvent, withLock, newId, newToken } from "../lib/store.js";

const ACTIONS = ["status", "day", "cancel-day", "vacation", "move-vacation", "cancel-vacation"];

export default async function handler(req, res) {
  if (!hasKey(req, "USER_KEY", "ADMIN_KEY")) return deny(res);
  res.setHeader("Cache-Control", "no-store");
  const input = { ...req.query, ...(req.method === "POST" ? readBody(req) : {}) };
  const action = String(input.action || "status");
  if (!ACTIONS.includes(action)) return reply(res, input, 400, { error: `action must be one of: ${ACTIONS.join(", ")}` });

  const now = Date.now();
  const run = async () => {
    const st = await loadState();
    const ctx = { now, policy: effectivePolicy(st.policyState, now), workoutEnds: satisfactoryEnds(st.sessions, now) };
    const d = decide({ now, policyState: st.policyState, sessions: st.sessions, passes: st.passes });
    let r = {};
    switch (action) {
      case "day": r = requestDayPass(st.passes, ctx, { reason: input.reason, compliance: { ...d.compliance, until: Date.parse(d.compliance.until) }, id: newId(), token: newToken() }); break;
      case "cancel-day": r = cancelDayPass(st.passes, ctx); break;
      case "vacation": r = scheduleVacation(st.passes, ctx, { start: parseStart(input.start), id: newId() }); break;
      case "move-vacation": r = moveVacation(st.passes, ctx, { start: parseStart(input.start) }); break;
      case "cancel-vacation": r = cancelVacation(st.passes, ctx); break;
    }
    if (r.passes) {
      await redis().set(K.passes, r.passes);
      await logEvent({ type: `pass-${action}`, reason: input.reason, start: input.start, message: r.message });
    } else if (r.error) {
      await logEvent({ type: `pass-${action}-refused`, error: r.error });
    }
    const after = r.passes ? decide({ now, policyState: st.policyState, sessions: st.sessions, passes: r.passes }) : d;
    return { ...r, d: after };
  };

  let r;
  try { r = action === "status" ? await run() : await withLock(run); }
  catch (e) { return reply(res, input, 503, { error: String(e?.message || e) }); }
  return reply(res, input, r.error ? 400 : 200, r);
}

function reply(res, input, code, r) {
  const d = r.d;
  const body = {
    ok: !r.error, message: r.message ?? null, error: r.error ?? null,
    ...(d && { allowed: d.allowed, reason: d.reason, compliance: d.compliance, passes: summaryForApi(d.passes) }),
  };
  if (input.format !== "text") return res.status(code).json(body);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(code).send([r.error ? `NO: ${r.error}` : r.message, d && statusText(d)].filter(Boolean).join("\n\n") + "\n");
}

function statusText(d) {
  const c = d.compliance, day = d.passes.day, vac = d.passes.vacation;
  const out = [];
  out.push(c.compliant
    ? `Workout rule: OK until ${fmtNY(Date.parse(c.until))} (${c.via.replace("_", " ")})`
    : `Workout rule: NOT compliant${c.until ? ` since ${fmtNY(Date.parse(c.until))}` : ""}`);
  const cur = day.current;
  const curText = !cur ? "" :
    cur.status === "requested" ? ` — requested; "are you sure?" email ${fmtNY(cur.askAt)}, lapses ${fmtNY(cur.lapsesAt)}` :
    cur.status === "confirmed" ? ` — confirmed; activates ${fmtNY(cur.activatesAt)}` :
    ` — ACTIVE until ${fmtNY(cur.endsAt)}`;
  out.push(`Day passes: ${day.leftThisMonth} of ${day.perMonth} left this month${curText}`);
  const v = vac.current;
  const vText = !v ? "none scheduled" :
    v.status === "scheduled" ? `scheduled ${fmtNY(v.start)} → ${fmtNY(v.endsAt)}` :
    v.status === "active" ? `ACTIVE until ${fmtNY(v.endsAt)}` :
    v.status === "waiting" ? `due since ${fmtNY(v.start)}, waiting for a workout (ends ${fmtNY(v.endsAt)})` :
    `can't start: ${v.blockedBy}`;
  out.push(`Vacation: ${vac.leftThisYear} of ${vac.perYear} left this year; ${vText}`);
  if (d.passes.nextPassNeedsWorkoutAfter) out.push(`Next pass needs a workout after ${fmtNY(d.passes.nextPassNeedsWorkoutAfter)}`);
  if (d.nightly.active) out.push(`Nightly lockout is on now (${d.nightly.window}) — passes never cover it`);
  return out.join("\n");
}
