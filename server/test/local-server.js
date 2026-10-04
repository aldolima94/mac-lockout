// Local stand-in for Vercel + Upstash, for testing the Mac daemon without deploying.
//   PORT=8787 MAC_KEY=m PHONE_KEY=p ADMIN_KEY=a DEV_RECOVERY=on node test/local-server.js
// Redis is an in-memory Map; emails are printed instead of sent.

import http from "node:http";

const mem = new Map();
const clone = v => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
globalThis.__TEST_REDIS__ = {
  async get(k) { return clone(mem.get(k)); },
  async mget(...ks) { return ks.map(k => clone(mem.get(k))); },
  async set(k, v) { mem.set(k, clone(v)); return "OK"; },
  async del(k) { mem.delete(k); return 1; },
  async lpush(k, v) { const l = mem.get(k) || []; l.unshift(v); mem.set(k, l); return l.length; },
  async ltrim(k, a, b) { mem.set(k, (mem.get(k) || []).slice(a, b + 1)); return "OK"; },
  async lrange(k, a, b) { return (mem.get(k) || []).slice(a, b + 1); },
};
globalThis.__TEST_MAILER__ = { async sendMail(m) { console.log(`[email] to=${m.to} subject=${m.subject}\n${m.text}`); } };
process.env.GMAIL_USER ||= "test@example.com";
process.env.GMAIL_APP_PASSWORD ||= "x";

const routes = {};
for (const name of ["permission", "workout", "policy", "admin", "events"]) {
  routes[`/api/${name}`] = (await import(`../api/${name}.js`)).default;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const handler = routes[url.pathname];
  let raw = "";
  for await (const c of req) raw += c;
  const vreq = { method: req.method, headers: req.headers, query: Object.fromEntries(url.searchParams), body: raw || undefined };
  if (raw && (req.headers["content-type"] || "").includes("json")) vreq.body = JSON.parse(raw);
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
