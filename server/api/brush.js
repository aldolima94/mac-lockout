// POST /api/brush — the iPhone Shortcut sends recent toothbrushing sessions from Apple Health.
// Key: PHONE_KEY.  Body: { "brushes_csv": "2026-10-19T07:58:02-03:00,2026-10-19T08:00:05-03:00\n..." }
//   (one session per line: start,end)  or  { "brushes": [{ start, end }] }
// Re-sending the same days is fine: sessions starting within a minute of each other are the same one.
// Add ?format=text (or "format": "text" in the body) for a short plain answer with your Sunday time.

import { decide } from "../lib/rules.js";
import { mergeBrushes, sundayText, BRUSH } from "../lib/sunday.js";
import { redis, K, hasKey, deny, readBody, loadState, logEvent, devRecovery } from "../lib/store.js";

function parseCsv(text) {
  return String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const [start, end] = line.split(",").map(x => x.trim());
    return { start, end };
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!hasKey(req, "PHONE_KEY")) return deny(res);

  const body = readBody(req);
  const found = body.brushes || (body.brushes_csv ? parseCsv(body.brushes_csv) : []);
  const now = Date.now();

  const st = await loadState();
  const brushes = mergeBrushes(st.brushes, found, now);
  await redis().set(K.brushes, brushes);
  await redis().set(K.phoneLast, now);

  const d = decide({ now, policyState: st.policyState, sessions: st.sessions, override: st.override, devRecovery: devRecovery(), passes: st.passes, brushes, usage: st.usage });
  const counted = found.filter(b => Date.parse(b.end) - Date.parse(b.start) >= BRUSH.minMinutes * 60_000).length;
  await logEvent({ type: "brush-post", received: found.length, longEnough: counted, sundayTotalMin: d.sunday.totalMin });

  if ((req.query.format || body.format) === "text") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(
      `Got ${found.length} brushing session${found.length === 1 ? "" : "s"} (${counted} of ${BRUSH.minMinutes}+ min).\n\n${sundayText(d.sunday)}\n`);
  }
  return res.status(200).json({ received: found.length, longEnough: counted, stored: brushes.length, sunday: d.sunday });
}
