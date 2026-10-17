// A whole week through the real handlers (in-memory Redis, fake clock):
// workouts and brushing from the phone, the Mac checking in, then Sunday
// until the time runs out, and the Monday reset.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, resetMemory } from "./memory.js";

Object.assign(process.env, {
  MAC_KEY: "m", PHONE_KEY: "p", USER_KEY: "u", ADMIN_KEY: "a", CRON_KEY: "c",
  GMAIL_USER: "randy@example.com", GMAIL_APP_PASSWORD: "x", APP_URL: "https://app.test",
});
const api = {};
for (const n of ["permission", "workout", "brush", "pass"]) api[n] = (await import(`../api/${n}.js`)).default;

const MIN = 60_000;
const sp = s => Date.parse(`${s.replace(" ", "T")}:00-03:00`);
async function call(name, { key, query = {}, body } = {}) {
  let status = 200, out;
  const res = { status(s) { status = s; return res; }, setHeader() {}, json(o) { out = o; return res; }, send(s) { out = s; return res; } };
  await api[name]({ method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, query, body }, res);
  return { status, body: out };
}
const mac = (present = true) => call("permission", { key: "m", query: { user_present: present ? "1" : "0", mode: "enforce", format: "text" } });
const field = (txt, k) => txt.match(new RegExp(`^${k}=(.*)$`, "m"))[1];
async function workoutAt(s) {
  clock.set(sp(s));
  const lines = [];
  for (let t = Date.now() - 25 * MIN; t <= Date.now(); t += 30_000) lines.push(`${new Date(t).toISOString()},130`);
  return call("workout", { key: "p", body: { samples_csv: lines.join("\n") } });
}
async function brushAt(s, seconds = 150) {
  clock.set(sp(s) + seconds * 1000 + MIN);
  const a = new Date(sp(s)).toISOString(), b = new Date(sp(s) + seconds * 1000).toISOString();
  return call("brush", { key: "p", query: { format: "text" }, body: { brushes_csv: `${a},${b}` } });
}

test("a week: earn on weekdays, spend on Sunday, reset on Monday", async () => {
  resetMemory();

  // Mon: workout, brush, at the Mac at 21:30 (late night → no early-night hour).
  await workoutAt("2026-10-19 07:00");
  await brushAt("2026-10-19 08:00");
  clock.set(sp("2026-10-19 21:29")); await mac();
  clock.set(sp("2026-10-19 21:30")); await mac();
  // Tue–Sat: brush once a day; nobody at the Mac after 21:00. Workouts Wed, Fri, Sat (Fri→Sat = streak).
  for (const d of ["20", "21", "22", "23", "24"]) await brushAt(`2026-10-${d} 08:00`);
  await workoutAt("2026-10-21 07:00");
  await workoutAt("2026-10-23 07:00");
  await workoutAt("2026-10-24 07:00");
  // The phone re-sends Friday's brushing: still counted once.
  await brushAt("2026-10-23 08:00");

  // Saturday evening, from the phone: 4h base + 3h brushing (6 days) + 1h streak + 4h early nights (Tue–Fri; Sat not over yet).
  clock.set(sp("2026-10-24 20:00"));
  let r = await call("pass", { key: "u", query: { format: "text" } });
  assert.match(r.body, /Sunday time banked for Sun, Oct 25: 12h\n  4h base \+ 3h brushing \+ 1h streaks \+ 4h early nights/);

  // Sunday: Saturday night was early too → 13h. Mac opened at 08:00, used straight through.
  clock.set(sp("2026-10-25 08:00"));
  r = await mac();
  assert.equal(field(r.body, "allowed"), "true");
  assert.equal(field(r.body, "sunday_total_minutes"), "780");
  assert.equal(field(r.body, "sunday_left_minutes"), "780");
  let cutoff = null;
  for (let i = 1; i <= 14 * 60; i++) {
    clock.set(sp("2026-10-25 08:00") + i * MIN);
    r = await mac();
    if (field(r.body, "allowed") === "false") { cutoff = i; break; }
    assert.ok(Number(field(r.body, "lease_seconds")) <= Number(field(r.body, "sunday_left_minutes")) * 60 + 60);
  }
  assert.equal(cutoff, 780, "denied exactly when 13h of use is spent (21:00)");
  assert.equal(field(r.body, "reason"), "sunday_time_used");
  r = await call("pass", { key: "u", query: { format: "text" } });
  assert.match(r.body, /Sunday time today: all used up\n  used 13h of 13h/);

  // Monday: a new week starts at 4h, nothing earned yet.
  clock.set(sp("2026-10-26 06:30"));
  r = await mac();
  assert.equal(field(r.body, "allowed"), "true");
  assert.equal(field(r.body, "sunday"), "2026-11-01");
  assert.equal(field(r.body, "sunday_total_minutes"), "240");
});

test("Sunday time only counts while you're at the screen and the Mac is awake", async () => {
  resetMemory();
  await workoutAt("2026-10-24 07:00");
  const at = async (hhmm, present = true) => { clock.set(sp(`2026-10-25 ${hhmm}`)); return mac(present); };
  await at("12:00"); await at("12:01"); await at("12:02");     // 2 min
  await at("12:03", false); await at("12:04", false);          // logged out → nothing
  await at("15:00"); await at("15:01");                        // asleep 12:04–15:00 → 1 min
  const r = await at("15:02");                                 // 1 min
  assert.equal(field(r.body, "sunday_used_minutes"), "4");
  // Before the first limited Sunday nothing is counted or limited.
  resetMemory();
  await workoutAt("2026-10-17 07:00");
  clock.set(sp("2026-10-18 12:00")); await mac();
  clock.set(sp("2026-10-18 12:01"));
  const r18 = await mac();
  assert.equal(field(r18.body, "sunday_limited"), "false");
  assert.equal(field(r18.body, "sunday_used_minutes"), "0");
});

test("brushing endpoint: key, answer, and the 2-minute rule", async () => {
  resetMemory();
  assert.equal((await call("brush", { key: "u", body: { brushes_csv: "" } })).status, 401);
  const r = await brushAt("2026-10-20 08:00", 100);
  assert.match(r.body, /Got 1 brushing session \(0 of 2\+ min\)/);
  const r2 = await brushAt("2026-10-20 21:00", 125);
  assert.match(r2.body, /Got 1 brushing session \(1 of 2\+ min\)/);
  assert.match(r2.body, /Sunday time banked for Sun, Oct 25: 5h 30m\n  4h base \+ 30m brushing \+ 0m streaks \+ 1h early nights/);
});
