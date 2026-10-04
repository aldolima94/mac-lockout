// POST /api/workout — the iPhone Shortcut sends recent heart-rate readings here.
// Same body as Workout Gate v2, so the Shortcut only needs a new URL (and key).
// Key: PHONE_KEY.  Body: { "samples_csv": "2026-09-30T18:44:05-03:00,103\n..." }  or  { "samples": [{t, bpm}] }

import { detectSessions, mergeSessions, decide } from "../lib/rules.js";
import { redis, K, hasKey, deny, readBody, loadState, logEvent, devRecovery } from "../lib/store.js";

function parseCsv(text) {
  return String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const c = line.lastIndexOf(",");
    return { t: line.slice(0, c).trim(), bpm: parseFloat(line.slice(c + 1)) };
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!hasKey(req, "PHONE_KEY")) return deny(res);

  const body = readBody(req);
  const samples = body.samples || (body.samples_csv ? parseCsv(body.samples_csv) : []);
  const now = Date.now();

  const st = await loadState();
  const before = decide({ now, policyState: st.policyState, sessions: st.sessions, override: st.override, devRecovery: devRecovery(), passes: st.passes });

  const found = detectSessions(samples);
  const sessions = mergeSessions(st.sessions, found, now);
  await redis().set(K.sessions, sessions);
  await redis().set(K.phoneLast, now);

  const after = decide({ now, policyState: st.policyState, sessions, override: st.override, devRecovery: devRecovery(), passes: st.passes });
  await logEvent({
    type: "workout-post", samples: samples.length, sessionsFound: found,
    compliantBefore: before.compliance.compliant, compliantAfter: after.compliance.compliant,
    compliantUntil: after.compliance.until, via: after.compliance.via,
  });

  return res.status(200).json({
    samplesReceived: samples.length,
    sessionsFound: found,
    allowed: after.allowed,
    reason: after.reason,
    compliance: after.compliance,
    workout: after.workout,
    dayPass: after.passes.day.current?.status ?? "none",
  });
}
