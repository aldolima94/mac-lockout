// /api/admin — development tools. Key: ADMIN_KEY. GET works so you can use it from a phone browser.
//
//   ?action=override&minutes=60   DEV RECOVERY: answer "allowed" for N minutes (max 240), whatever the rules say
//   ?action=clear-override        end the override now
//   ?action=reset-workouts        forget all workouts → you're noncompliant (for re-running the test)
//   ?action=test-email            send yourself a test email
//
// override and reset-workouts only work while DEV_RECOVERY=on in Vercel. Remove that
// variable when development is over and the override stops existing.

import { redis, K, hasKey, deny, logEvent, sendMail, devRecovery } from "../lib/store.js";

export default async function handler(req, res) {
  if (!hasKey(req, "ADMIN_KEY")) return deny(res);
  res.setHeader("Cache-Control", "no-store");
  const action = String(req.query.action || req.body?.action || "");
  const now = Date.now();
  const needDev = () => res.status(403).json({ error: "DEV_RECOVERY is not on" });

  switch (action) {
    case "override": {
      if (!devRecovery()) return needDev();
      const minutes = Math.min(240, Math.max(1, Number(req.query.minutes) || 60));
      const until = now + minutes * 60_000;
      await redis().set(K.override, { until, setAt: now });
      await logEvent({ type: "dev-override-set", minutes, until: new Date(until).toISOString() });
      return res.status(200).json({ override: true, until: new Date(until).toISOString() });
    }
    case "clear-override":
      await redis().del(K.override);
      await logEvent({ type: "dev-override-cleared" });
      return res.status(200).json({ override: false });
    case "reset-workouts":
      if (!devRecovery()) return needDev();
      await redis().del(K.sessions);
      await logEvent({ type: "workouts-reset" });
      return res.status(200).json({ workoutsReset: true });
    case "test-email": {
      const sent = await sendMail("Mac Lockout: test email", "If you're reading this, Mac Lockout can email you.");
      return res.status(200).json({ sent });
    }
    default:
      return res.status(400).json({ error: "action must be override | clear-override | reset-workouts | test-email" });
  }
}
