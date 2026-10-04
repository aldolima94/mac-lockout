// GET /api/tick — the scheduler. Call it every 5 minutes (cron-job.org or Upstash QStash).
// Key: CRON_KEY (Authorization: Bearer … or ?key=…).
//
// Each run:
//   1. passes: writes down outcomes (activated, lapsed, cancelled by a workout, vacation
//      started…), sends the "are you sure?" email 30 min after a day-pass request, and
//      tells you about anything that changed;
//   2. escalation: warning to you, then emails to you + your partner (lib/escalation.js);
//   3. vacation: keeps the Mac's shutdown alarm (MAC_HEALTHCHECK_URL) quiet while a
//      vacation is active, and re-arms it afterwards;
//   4. pings CRON_HEALTHCHECK_URL — "/fail" if anything went wrong, including any
//      email that failed to send since the last run. If this endpoint stops being
//      called, that check goes down and Healthchecks alerts whoever owns it.
// Always answers 200 (so the scheduler doesn't disable the job); problems go to Healthchecks.

import { decide, effectivePolicy, satisfactoryEnds } from "../lib/rules.js";
import { settlePasses, asksDue, dayRequests } from "../lib/passes.js";
import { escalate, partnerFirstAt, vacationAlarm } from "../lib/escalation.js";
import { dayAsk, notice, warning, partnerAlert, backOnTrack } from "../lib/messages.js";
import { redis, K, hasKey, deny, loadState, logEvent, withLock, appUrl, mailMe, mailTo, partner, devRecovery } from "../lib/store.js";

const ping = (url, body) => fetch(url, { method: "POST", body, signal: AbortSignal.timeout(5000) }).catch(() => {});
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export default async function handler(req, res) {
  if (!hasKey(req, "CRON_KEY")) return deny(res);
  res.setHeader("Cache-Control", "no-store");
  const now = Date.now(), base = appUrl(req), done = [], problems = [];

  try {
    // 1. passes
    const st = await withLock(async () => {
      const st = await loadState();
      const ctx = { now, policy: effectivePolicy(st.policyState, now), workoutEnds: satisfactoryEnds(st.sessions, now) };
      const s = settlePasses(st.passes, ctx);
      for (const p of asksDue(s.passes, ctx)) {
        if (await mailMe(dayAsk(p, base, ctx.policy))) { p.askedAt = now; done.push(`asked: ${p.id}`); }
      }
      if (!same(s.passes, st.passes)) await redis().set(K.passes, s.passes);
      for (const n of s.notices) {
        await logEvent({ type: `pass-${n.type}`, id: n.pass.id });
        await mailMe(notice(n));
        done.push(n.type);
      }
      return { ...st, passes: s.passes };
    });

    const d = decide({ now, policyState: st.policyState, sessions: st.sessions, override: st.override, devRecovery: devRecovery(), passes: st.passes });
    const ctx = { now, policy: d.policy, workoutEnds: satisfactoryEnds(st.sessions, now) };

    // 2. escalation
    const e = escalate(st.escalation, {
      now, compliant: d.compliance.compliant,
      compliantUntil: d.compliance.until ? Date.parse(d.compliance.until) : null,
      requests: dayRequests(st.passes, ctx),
    });
    if (!same(e.state, st.escalation)) await redis().set(K.escalation, e.state);
    if (e.send) {
      const p = partner(), since = e.send.since;
      const lastWorkout = d.workout.lastSatisfactoryWorkout ? Date.parse(d.workout.lastSatisfactoryWorkout) : null;
      const m =
        e.send.kind === "warning" ? warning({ since, partnerAt: partnerFirstAt(since, e.state.warnedAt), partnerName: p.name, dayLeft: d.passes.day.leftThisMonth, passNeedsWorkoutAfter: d.passes.nextPassNeedsWorkoutAfter }) :
        e.send.kind === "partner" ? partnerAlert({ since, now, partner: p, lastWorkout, windowHours: d.policy.workoutWindowHours }) :
        backOnTrack({ since, now, via: d.compliance.via, partner: p });
      await logEvent({ type: `escalation-${e.send.kind}`, to: e.send.to, step: e.send.step, since: new Date(since).toISOString() });
      await mailTo(e.send.to, m);
      done.push(`escalation: ${e.send.kind}`);
    }

    // 3. vacation: the Mac's shutdown alarm
    const va = vacationAlarm(st.vacAlarm, {
      now, vacationActive: d.passes.vacationActive, lastVacationEnd: d.passes.lastVacationEnd, macLastAt: st.macLast?.at ?? null,
    });
    if (va.action && process.env.MAC_HEALTHCHECK_URL) {
      await ping(process.env.MAC_HEALTHCHECK_URL + (va.action === "rearm" ? "/start" : ""), "mac-lockout scheduler: vacation");
      if (va.action === "rearm") await logEvent({ type: "vacation-alarm-rearmed" });
      done.push(`mac check: ${va.action}`);
    }
    if (!same(va.state, st.vacAlarm)) await redis().set(K.vacAlarm, va.state);

    // 4. any email that failed since the last run
    const mf = await redis().get(K.mailFail);
    if (mf) { problems.push(`email failed: ${mf.subject}: ${mf.error}`); await redis().del(K.mailFail); }
  } catch (err) {
    problems.push(String(err?.stack || err));
    try { await logEvent({ type: "tick-error", error: String(err?.message || err) }); } catch {}
  }

  if (process.env.CRON_HEALTHCHECK_URL) {
    await ping(process.env.CRON_HEALTHCHECK_URL + (problems.length ? "/fail" : ""), problems.join("\n").slice(0, 9000) || "ok");
  }
  return res.status(200).json({ ok: problems.length === 0, done, problems });
}
