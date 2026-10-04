// /api/policy — view (USER_KEY or ADMIN_KEY) or change (ADMIN_KEY only) the restrictions.
//
//   GET  /api/policy                                   current values, baselines, pending loosenings
//   GET  /api/policy?set=workoutWindowHours&value=36   (or POST {set, value}) — ADMIN_KEY
//
// Stricter → immediate. Looser (toward the baseline) → takes effect after 72 h.
// Past the baseline → refused.

import { BASELINE, LOOSEN_DELAY_HOURS, effectivePolicy, applyChange } from "../lib/rules.js";
import { redis, K, hasKey, deny, readBody, logEvent } from "../lib/store.js";

export default async function handler(req, res) {
  if (!hasKey(req, "USER_KEY", "ADMIN_KEY")) return deny(res);
  res.setHeader("Cache-Control", "no-store");
  const now = Date.now();
  const state = await redis().get(K.policy);
  const input = req.method === "POST" ? readBody(req) : req.query;

  if (input.set) {
    if (!hasKey(req, "ADMIN_KEY")) return res.status(403).json({ error: "only the admin key (your partner) can change the rules" });
    const value = Number(input.value);
    const r = applyChange(state, String(input.set), value, now);
    if (r.error) {
      await logEvent({ type: "policy-refused", set: input.set, value: input.value, error: r.error });
      return res.status(400).json({ error: r.error });
    }
    await redis().set(K.policy, r.state);
    await logEvent({ type: "policy-change", set: input.set, value, kind: r.kind });
    return res.status(200).json({ changed: input.set, value, kind: r.kind, ...view(r.state, now) });
  }
  return res.status(200).json(view(state, now));
}

function view(state, now) {
  return {
    effective: effectivePolicy(state, now),
    baseline: Object.fromEntries(Object.entries(BASELINE).map(([k, b]) => [k, b.value])),
    pending: Object.fromEntries(Object.entries(state?.pending || {}).filter(([, p]) => p.effectiveAt > now)
      .map(([k, p]) => [k, { value: p.value, effectiveAt: new Date(p.effectiveAt).toISOString() }])),
    loosenDelayHours: LOOSEN_DELAY_HOURS,
  };
}
