// POST /api/read — the iPhone's Books Shortcuts: one runs when Apple Books opens, one when it closes.
// Key: PHONE_KEY.  Body: { "event": "open" } or { "event": "close" }  (or ?event=open|close)
// Each finished session earns weekend time minute for minute (lib/weekend.js), the weekend
// included. The server's clock is the time of each event.
// Add ?format=text (or "format": "text" in the body) for a short plain answer with your weekend time.

import { decide } from "../lib/rules.js";
import { readingEvent, weekendText } from "../lib/weekend.js";
import { redis, K, hasKey, deny, readBody, loadState, logEvent, devRecovery } from "../lib/store.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!hasKey(req, "PHONE_KEY")) return deny(res);

  const body = readBody(req);
  const event = String(body.event || req.query.event || "").toLowerCase();
  if (event !== "open" && event !== "close") return res.status(400).json({ error: "event must be open or close" });
  const now = Date.now();

  const st = await loadState();
  const r = readingEvent(st.reading, { now, event });
  await redis().set(K.reading, r.state);
  await redis().set(K.phoneLast, now);
  await logEvent({ type: `read-${event}`, result: r.result, minutes: r.minutes });

  const d = decide({ now, policyState: st.policyState, sessions: st.sessions, override: st.override, devRecovery: devRecovery(), passes: st.passes, brushes: st.brushes, usage: st.usage, reading: r.state });
  if ((req.query.format || body.format) === "text") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(`Reading: ${r.result}.\n\n${weekendText(d.weekend)}\n`);
  }
  return res.status(200).json({ event, result: r.result, minutes: r.minutes, weekend: d.weekend });
}
