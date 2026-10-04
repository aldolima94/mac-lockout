// Local stand-in for Vercel + Upstash, for testing the Mac daemon without deploying.
//   PORT=8787 MAC_KEY=m PHONE_KEY=p ADMIN_KEY=a DEV_RECOVERY=on node test/local-server.js
// Redis is an in-memory Map; emails are printed instead of sent; Healthchecks URLs
// starting with http://hc.test are recorded instead of called.
// Test-only routes: /__test/advance?minutes=N moves the server's clock; /__test/emails lists emails.

import http from "node:http";

import { clock, emails } from "./memory.js";
process.env.PRINT_EMAILS ||= "1";
process.env.GMAIL_USER ||= "test@example.com";
process.env.GMAIL_APP_PASSWORD ||= "x";

const routes = {};
for (const name of ["permission", "workout", "policy", "admin", "events", "pass", "confirm", "tick"]) {
  routes[`/api/${name}`] = (await import(`../api/${name}.js`)).default;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const handler = routes[url.pathname];
  let raw = "";
  for await (const c of req) raw += c;
  const vreq = { method: req.method, headers: req.headers, query: Object.fromEntries(url.searchParams), body: raw || undefined };
  const type = req.headers["content-type"] || "";
  if (raw && type.includes("json")) vreq.body = JSON.parse(raw);
  if (raw && type.includes("x-www-form-urlencoded")) vreq.body = Object.fromEntries(new URLSearchParams(raw));
  if (url.pathname === "/__test/advance") { clock.advance(Number(url.searchParams.get("minutes") || 0) * 60_000); res.end(new Date(Date.now()).toISOString() + "\n"); return; }
  if (url.pathname === "/__test/emails") { res.end(JSON.stringify(emails, null, 2)); return; }
  let status = 200;
  const vres = {
    status(s) { status = s; return vres; },
    setHeader(k, v) { res.setHeader(k, v); },
    json(o) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o, null, 2)); },
    send(s) { res.writeHead(status); res.end(s); },
  };
  if (!handler) return vres.status(404).json({ error: "not found" });
  try { await handler(vreq, vres); } catch (e) { console.error(e); vres.status(500).json({ error: String(e) }); }
}).listen(Number(process.env.PORT || 8787), () => console.log(`local server on :${process.env.PORT || 8787}`));
