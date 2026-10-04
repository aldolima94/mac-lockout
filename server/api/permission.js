// GET /api/permission — "Is Randy permitted to use the MacBook right now?"
//
// Key: MAC_KEY (the daemon) or ADMIN_KEY (you, read-only look).
// Query from the daemon:  user_present=1|0   mode=dryrun|enforce   format=text
// ?now=<ISO time> pretends it's another time (ADMIN_KEY + DEV_RECOVERY=on only; nothing is recorded).

import { decide, trackInUse, fmtNY } from "../lib/rules.js";
import { redis, K, hasKey, deny, loadState, logEvent, sendMail, devRecovery } from "../lib/store.js";

export default async function handler(req, res) {
  const isMac = hasKey(req, "MAC_KEY");
  if (!isMac && !hasKey(req, "ADMIN_KEY")) return deny(res);
  res.setHeader("Cache-Control", "no-store");

  let now = Date.now(), simulated = false;
  if (!isMac && req.query.now && devRecovery()) {
    const t = Date.parse(req.query.now);
    if (!isNaN(t)) { now = t; simulated = true; }
  }

  const st = await loadState();
  const d = decide({ now, policyState: st.policyState, sessions: st.sessions, override: st.override, devRecovery: devRecovery() });

  if (isMac) {
    const userPresent = req.query.user_present === "1";
    const mode = req.query.mode === "enforce" ? "enforce" : "dryrun";
    await redis().set(K.macLast, { at: now, userPresent, mode });

    // Dead man's switch: every Mac check-in pings Healthchecks.io. If the daemon
    // stops checking in (deleted, unloaded, or the Mac is off/asleep), the
    // check goes down and Healthchecks alerts you.
    if (process.env.MAC_HEALTHCHECK_URL) {
      try { await fetch(process.env.MAC_HEALTHCHECK_URL, { signal: AbortSignal.timeout(3000) }); } catch {}
    }

    // Log every change of answer, with the facts behind it.
    const key = `${d.allowed}:${d.reason}:${d.devOverride.active}`;
    if (!st.last || st.last.key !== key) {
      await redis().set(K.last, { key, at: now });
      await logEvent({
        type: "decision", allowed: d.allowed, reason: d.reason, devOverride: d.devOverride.active,
        nightActive: d.nightly.active, compliant: d.workout.compliant,
        compliantUntil: d.workout.compliantUntil, lastSatisfactoryWorkout: d.workout.lastSatisfactoryWorkout,
      });
    }

    // Safeguard: someone keeps using the Mac while the answer is "no".
    const t = trackInUse(st.inUse, { now, allowed: d.allowed, userPresent });
    if (JSON.stringify(t.state) !== JSON.stringify(st.inUse ?? null)) await redis().set(K.inUse, t.state);
    if (t.sendAlert) {
      const mins = Math.round((now - t.state.since) / 60000);
      await logEvent({ type: "in-use-while-denied", reason: d.reason, minutes: mins, mode });
      try {
        await sendMail(
          `Mac Lockout: MacBook in use while denied (${d.reason})`,
          `Your MacBook has reported someone logged in for ${mins} minutes while access is denied.\n\n` +
          `Reason: ${d.reason}\nSince: ${fmtNY(t.state.since)}\nMac mode: ${mode}` +
          (mode === "enforce" ? " — the logout isn't working." : " — the daemon is in dry-run mode, so it isn't logging you out.") +
          `\nLast satisfactory workout: ${d.workout.lastSatisfactoryWorkout ? fmtNY(Date.parse(d.workout.lastSatisfactoryWorkout)) : "none on record"}\n`,
        );
      } catch (e) {
        await logEvent({ type: "email-failed", error: String(e?.message || e) });
      }
    }
  }

  const body = { ...d, simulated, macLastSeen: st.macLast ? { ...st.macLast, at: new Date(st.macLast.at).toISOString() } : null };
  if (req.query.format === "text") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(toText(body));
  }
  return res.status(200).json(body);
}

// Flat key=value lines for the Mac daemon (no JSON parser needed in bash).
function toText(d) {
  const v = x => (x === null || x === undefined ? "" : String(x).replace(/[\r\n]/g, " "));
  return [
    ["allowed", d.allowed],
    ["reason", d.reason],
    ["lease_seconds", d.leaseSeconds],
    ["server_time", d.now],
    ["night_active", d.nightly.active],
    ["night_window", d.nightly.window],
    ["compliant", d.workout.compliant],
    ["compliant_until", d.workout.compliantUntil],
    ["last_satisfactory_workout", d.workout.lastSatisfactoryWorkout],
    ["workout_window_hours", d.workout.windowHours],
    ["dev_override", d.devOverride.active],
    ["dev_override_until", d.devOverride.until],
  ].map(([k, x]) => `${k}=${v(x)}`).join("\n") + "\n";
}
