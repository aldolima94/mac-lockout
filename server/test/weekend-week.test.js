// The weekend pool through the real handlers (in-memory Redis, fake clock):
// brushing from the phone, the Books Shortcuts, and the Mac running out of
// weekend time and getting it back by reading.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, resetMemory } from "./memory.js";

Object.assign(process.env, {
  MAC_KEY: "m", PHONE_KEY: "p", USER_KEY: "u", ADMIN_KEY: "a", CRON_KEY: "c",
  GMAIL_USER: "randy@example.com", GMAIL_APP_PASSWORD: "x", APP_URL: "https://app.test",
});
const api = {};
for (const n of ["permission", "workout", "pass", "brush", "read"]) api[n] = (await import(`../api/${n}.js`)).default;

const MIN = 60_000;
const sp = s => Date.parse(`${s.replace(" ", "T")}:00-03:00`);
async function call(name, { key, query = {}, body } = {}) {
  let status = 200, out;
  const res = { status(s) { status = s; return res; }, setHeader() {}, json(o) { out = o; return res; }, send(s) { out = s; return res; } };
  await api[name]({ method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, query, body }, res);
  return { status, body: out };
}
const field = (txt, k) => txt.match(new RegExp(`^${k}=(.*)$`, "m"))[1];
async function mac(from, to = from) {
  let r;
  for (let t = sp(from); t <= sp(to); t += MIN) {
    clock.set(t);
    r = await call("permission", { key: "m", query: { user_present: "1", idle_seconds: "0", mode: "enforce", format: "text" } });
  }
  return r;
}
async function workoutAt(s) {
  clock.set(sp(s));
  const lines = [];
  for (let t = Date.now() - 26 * MIN; t <= Date.now(); t += 30_000) lines.push(`${new Date(t).toISOString()},130`);
  return call("workout", { key: "p", body: { samples_csv: lines.join("\n") } });
}
// plusMs: the test clock drifts a few ms per request, so a close lands a little after the minute.
const read = async (s, event, plusMs = 0) => { clock.set(sp(s) + plusMs); return (await call("read", { key: "p", body: { event, format: "text" } })).body; };

test("a pool week: 5 brushes, the Mac all week, Saturday runs out, reading earns it back", async () => {
  resetMemory();
  const days = ["09", "10", "11", "12", "13"].map(d => `2026-11-${d}`);
  for (const d of days) {
    await workoutAt(`${d} 07:00`);
    await mac(`${d} 08:00`, `${d} 22:00`);           // at the Mac the whole earning window
  }
  // Brushing reaches the server in one go on Friday night: 5 of them.
  clock.set(sp("2026-11-13 23:00"));
  const csv = days.map(d => `${d}T08:30:00-03:00,${d}T08:32:10-03:00`).join("\n");
  const b = await call("brush", { key: "p", body: { brushes_csv: csv, format: "text" } });
  // Streaks Tue–Fri (4 h) + brushing (2h 30m) = 6h 30m.
  assert.match(b.body, /Weekend time banked for the weekend of Sat, Nov 14: 6h 30m \(at most 16h\)\n  brushing 5 of 5 needed Mon–Fri: done\n  0m off the Mac \+ 0m early nights \+ 4h streaks \+ 2h 30m brushing \+ 0m reading/);

  await workoutAt("2026-11-14 07:00");               // Saturday's streak day: +1 h
  let r = await mac("2026-11-14 09:00", "2026-11-14 16:30");
  assert.equal(field(r.body, "allowed"), "false");
  assert.equal(field(r.body, "reason"), "weekend_time_used");
  assert.equal(field(r.body, "weekend_used_minutes"), "450");
  assert.equal(field(r.body, "saturday"), "");        // no Saturday bank any more

  // 30 minutes in Books: the Mac is allowed again, for 30 minutes.
  assert.match(await read("2026-11-14 16:40", "open"), /Reading: started/);
  assert.match(await read("2026-11-14 17:10", "close", 30_000), /Reading: counted 30m\.\n\nWeekend time: 30m left/);
  r = await mac("2026-11-14 17:11");
  assert.equal(field(r.body, "allowed"), "true");
  assert.equal(field(r.body, "weekend_left_minutes"), "30");
  r = await mac("2026-11-14 17:12", "2026-11-14 17:42");
  assert.equal(field(r.body, "reason"), "weekend_time_used");

  // Bad requests.
  clock.set(sp("2026-11-14 18:00"));
  assert.equal((await call("read", { key: "p", body: { event: "pause" } })).status, 400);
  assert.equal((await call("read", { key: "m", body: { event: "open" } })).status, 401);
});
