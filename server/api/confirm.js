// /api/confirm?t=TOKEN — the link in the "are you sure?" email. No key: the
// token in the link is the key, and it only works for that one day pass.
// GET shows the question with two buttons; the buttons POST back here.
// (Two steps so that an email scanner opening the link can't confirm anything.)

import { effectivePolicy, satisfactoryEnds } from "../lib/rules.js";
import { dayStatus, confirmDayPass, cancelDayPass, lapseAt } from "../lib/passes.js";
import { fmtNY } from "../lib/time.js";
import { redis, K, readBody, loadState, logEvent, withLock } from "../lib/store.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const input = { ...req.query, ...(req.method === "POST" ? readBody(req) : {}) };
  const token = String(input.t || "");
  const now = Date.now();
  const ctxOf = st => ({ now, policy: effectivePolicy(st.policyState, now), workoutEnds: satisfactoryEnds(st.sessions, now) });

  if (req.method !== "POST") {
    const st = await loadState();
    const p = token && st.passes.find(x => x.kind === "day" && x.token === token);
    if (!p) return page(res, 404, "Link not valid", "This link doesn't match any day pass.");
    const status = dayStatus(p, ctxOf(st));
    const facts = `<p>Requested ${fmtNY(p.requestedAt)}<br>Reason: <b>${esc(p.reason)}</b></p>`;
    if (status === "requested") {
      const pol = ctxOf(st).policy;
      return page(res, 200, "Are you sure?", facts +
        `<p>If you confirm, the day pass activates ${pol.dayPassActivateMinutes} minutes from now and covers the workout rule for ${pol.dayPassHours} h. ` +
        `It's spent once it activates. This link works until ${fmtNY(lapseAt(p))}.</p>` +
        form(token, "confirm", "Yes, I'm sure") + form(token, "cancel", "No, cancel it", true));
    }
    if (status === "confirmed") {
      return page(res, 200, "Confirmed", facts + `<p>It activates ${fmtNY(p.activatesAt)}. You can still cancel it until then.</p>` +
        form(token, "cancel", "Cancel it", true));
    }
    return page(res, 200, `This day pass is ${status}`, facts);
  }

  const what = input.do === "confirm" ? "confirm" : input.do === "cancel" ? "cancel" : null;
  if (!what) return page(res, 400, "Nothing done", "Unknown action.");
  let r;
  try {
    r = await withLock(async () => {
      const st = await loadState();
      const out = what === "confirm" ? confirmDayPass(st.passes, ctxOf(st), token) : cancelDayPass(st.passes, ctxOf(st), token);
      if (out.passes) await redis().set(K.passes, out.passes);
      await logEvent({ type: `pass-${what}${out.error ? "-refused" : ""}`, via: "email link", message: out.message, error: out.error });
      return out;
    });
  } catch (e) { return page(res, 503, "Try again", esc(String(e?.message || e))); }
  return page(res, r.error ? 400 : 200, r.error ? "Nothing done" : what === "confirm" ? "Confirmed" : "Cancelled", esc(r.error || r.message));
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const form = (t, act, label, secondary = false) =>
  `<form method="post"><input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="do" value="${act}">` +
  `<button class="${secondary ? "b2" : ""}">${label}</button></form>`;

function page(res, code, title, html) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(code).send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mac Lockout: ${esc(title)}</title>
<style>body{font:17px/1.45 -apple-system,system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
h1{font-size:1.4rem}button{width:100%;font-size:1.1rem;padding:.9rem;margin:.4rem 0;border:0;border-radius:.6rem;background:#111;color:#fff}
.b2{background:#e5e5e5;color:#111}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}.b2{background:#333;color:#eee}}</style>
</head><body><h1>${esc(title)}</h1>${html}</body></html>`);
}
