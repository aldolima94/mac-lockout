// GET /api/events — what happened, newest first (decisions, workouts, overrides, emails). Key: ADMIN_KEY.
// ?n=100 for more (max 300).

import { redis, K, hasKey, deny } from "../lib/store.js";

export default async function handler(req, res) {
  if (!hasKey(req, "ADMIN_KEY")) return deny(res);
  res.setHeader("Cache-Control", "no-store");
  const n = Math.min(300, Math.max(1, Number(req.query.n) || 50));
  const raw = await redis().lrange(K.events, 0, n - 1);
  return res.status(200).json({ events: raw.map(e => (typeof e === "string" ? JSON.parse(e) : e)) });
}
