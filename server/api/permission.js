// GET /api/permission — "Is Randy permitted to use the MacBook right now?"
//
// Key: MAC_KEY (the daemon), or USER_KEY / ADMIN_KEY (a read-only look).
// Query from the daemon:  user_present=1|0   mode=dryrun|enforce   format=text
// ?now=<ISO time> pretends it's another time (ADMIN_KEY + DEV_RECOVERY=on only; nothing is recorded).

import { decide, trackInUse } from "../lib/rules.js";
import { summaryForApi } from "../lib/passes.js";
import { inUse as inUseMail } from "../lib/messages.js";
import { iso } from "../lib/time.js";
import { redis, K, hasKey, deny, loadState, logEvent, mailTo, partner, devRecovery } from "../lib/store.js";

export default async function handler(req, res) {
  const isMac = hasKey(req, "MAC_KEY");
  if (!isMac && !hasKey(req, "USER_KEY", "ADMIN_KEY")) return deny(res);
  res.setHeader("Cache-Control", "no-store");

  let now = Date.now(), simulated = false;
  if (hasKey(req, "ADMIN_KEY") && req.query.now && devRecovery()) {
    const t = Date.parse(req.query.now);
    if (!isNaN(t)) { now = t; simulated = true; }
  }

  const st = await loadState();
  const d = decide({ now, policyState: st.policyState, sessions: st.sessions, override: st.override, devRecovery: devRecovery(), passes: st.passes });

  if (isMac) {
    const userPresent = req.query.user_present === "1";
    const mode = req.query.mode === "enforce" ? "enforce" : "dryrun";
    await redis().set(K.macLast, { at: now, userPresent, mode });

    // Dead man's switch: every Mac check-in pings Healthchecks.io ("success").
    // The daemon itself sends "start" when it's stopped (see mac/maclockoutd.sh).
    if (process.env.MAC_HEALTHCHECK_URL) {
      try { await fetch(process.env.MAC_HEALTHCHECK_URL, { signal: AbortSignal.timeout(3000) }); } catch {}
    }

    // Log every change of answer, with the facts behind it.
    const key = `${d.allowed}:${d.reason}:${d.devOverride.active}:${d.compliance.via}`;
    if (!st.last || st.last.key !== key) {
      await redis().set(K.last, { key, at: now });
      await logEvent({
        type: "decision", allowed: d.allowed, reason: d.reason, devOverride: d.devOverride.active,
        nightActive: d.nightly.active, compliant: d.compliance.compliant, compliantVia: d.compliance.via,
        compliantUntil: d.compliance.until, lastSatisfactoryWorkout: d.workout.lastSatisfactoryWorkout,
      });
    }

    // Safeguard: someone keeps using the Mac while the answer is "no".
    // First email of an episode → you; later ones → you and your partner.
    const t = trackInUse(st.inUse, { now, allowed: d.allowed, userPresent });
    if (JSON.stringify(t.state) !== JSON.stringify(st.inUse ?? null)) await redis().set(K.inUse, t.state);
    if (t.sendAlert) {
      const minutes = Math.round((now - t.state.since) / 60000);
      await logEvent({ type: "in-use-while-denied", reason: d.reason, minutes, mode, to: t.to });
      const last = d.workout.lastSatisfactoryWorkout ? Date.parse(d.workout.lastSatisfactoryWorkout) : null;
      await mailTo(t.to, inUseMail({ reason: d.reason, minutes, since: t.state.since, mode, lastWorkout: last, partner: partner() }));
    }
  }

  const body = {
    ...d, passes: summaryForApi(d.passes), simulated,
    macLastSeen: st.macLast ? { ...st.macLast, at: iso(st.macLast.at) } : null,
  };
  if (req.query.format === "text") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(toText(body));
  }
  return res.status(200).json(body);
}

// Flat key=value lines for the Mac daemon (no JSON parser needed in bash).
function toText(d) {
  const v = x => (x === null || x === undefined ? "" : String(x).replace(/[\r\n]/g, " "));
  const day = d.passes.day, vac = d.passes.vacation;
  return [
    ["allowed", d.allowed],
    ["reason", d.reason],
    ["lease_seconds", d.leaseSeconds],
    ["server_time", d.now],
    ["night_active", d.nightly.active],
    ["night_window", d.nightly.window],
    ["compliant", d.compliance.compliant],
    ["compliant_via", d.compliance.via],
    ["compliant_until", d.compliance.until],
    ["last_satisfactory_workout", d.workout.lastSatisfactoryWorkout],
    ["workout_window_hours", d.workout.windowHours],
    ["day_passes_left", day.leftThisMonth],
    ["day_passes_per_month", day.perMonth],
    ["day_pass", day.current?.status ?? "none"],
    ["day_pass_lapses_at", day.current?.lapsesAt],
    ["day_pass_activates_at", day.current?.activatesAt],
    ["day_pass_ends_at", day.current?.endsAt],
    ["vacations_left_year", vac.leftThisYear],
    ["vacations_per_year", vac.perYear],
    ["vacation", vac.current?.status ?? "none"],
    ["vacation_start", vac.current?.startAt ?? vac.current?.start],
    ["vacation_ends_at", vac.current?.endsAt],
    ["next_pass_needs_workout_after", d.passes.nextPassNeedsWorkoutAfter],
    ["dev_override", d.devOverride.active],
    ["dev_override_until", d.devOverride.until],
  ].map(([k, x]) => `${k}=${v(x)}`).join("\n") + "\n";
}
