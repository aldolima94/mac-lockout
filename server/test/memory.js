// Test doubles: in-memory Redis, captured emails, captured pings, and a movable clock.
// Used by test/api.test.js and test/local-server.js.

const mem = new Map();
const clone = v => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
globalThis.__TEST_REDIS__ = {
  async get(k) { return clone(mem.get(k)); },
  async mget(...ks) { return ks.map(k => clone(mem.get(k))); },
  async set(k, v, opts) {
    if (opts?.nx && mem.has(k)) return null;
    mem.set(k, clone(v)); return "OK";
  },
  async del(k) { mem.delete(k); return 1; },
  async lpush(k, v) { const l = mem.get(k) || []; l.unshift(v); mem.set(k, l); return l.length; },
  async ltrim(k, a, b) { mem.set(k, (mem.get(k) || []).slice(a, b + 1)); return "OK"; },
  async lrange(k, a, b) { return (mem.get(k) || []).slice(a, b + 1); },
};
export const resetMemory = () => mem.clear();

export const emails = [];
export const mailer = { fail: false };
globalThis.__TEST_MAILER__ = {
  async sendMail(m) {
    if (mailer.fail) throw new Error("smtp down");
    emails.push(m);
    if (process.env.PRINT_EMAILS) console.log(`[email] to=${m.to} subject=${m.subject}\n${m.text}\n`);
  },
};

// Pings to Healthchecks (any URL starting with http://hc.test) are recorded, not sent.
export const pings = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith("http://hc.test")) { pings.push(String(url)); return new Response("OK"); }
  return realFetch(url, opts);
};

// Movable clock.
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
export const clock = {
  set(ts) { offset = ts - realNow(); },
  advance(ms) { offset += ms; },
};
