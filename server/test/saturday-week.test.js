// The first week earning by the minute, through the real handlers (in-memory
// Redis, fake clock): the Mac checking in once a minute on weekdays, Saturday
// until its time runs out, Sunday's early nights, and the admin's forgive-night.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, resetMemory } from "./memory.js";

Object.assign(process.env, {
  MAC_KEY: "m", PHONE_KEY: "p", USER_KEY: "u", ADMIN_KEY: "a", CRON_KEY: "c",
  GMAIL_USER: "randy@example.com", GMAIL_APP_PASSWORD: "x", APP_URL: "https://app.test",
});
const api = {};
for (const n of ["permission", "workout", "pass", "admin"]) api[n] = (await import(`../api/${n}.js`)).default;

const MIN = 60_000;
const sp = s => Date.parse(`${s.replace(" ", "T")}:00-03:00`);
async function call(name, { key, query = {}, body } = {}) {
  let status = 200, out;
  const res = { status(s) { status = s; return res; }, setHeader() {}, json(o) { out = o; return res; }, send(s) { out = s; return res; } };
  await api[name]({ method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, query, body }, res);
  return { status, body: out };
}
const field = (txt, k) => txt.match(new RegExp(`^${k}=(.*)$`, "m"))[1];
// The Mac checking in once a minute, from `from` to `to` (São Paulo). idle(t) → seconds since last touched.
async function mac(from, to = from, idle = () => 0, present = true) {
  let r;
  for (let t = typeof from === "number" ? from : sp(from); t <= (typeof to === "number" ? to : sp(to)); t += MIN) {
    clock.set(t);
    r = await call("permission", { key: "m", query: { user_present: present ? "1" : "0", idle_seconds: String(idle(t)), mode: "enforce", format: "text" } });
  }
  return r;
}
async function workoutAt(s, minutes = 26) {
  clock.set(sp(s));
  const lines = [];
  for (let t = Date.now() - minutes * MIN; t <= Date.now(); t += 30_000) lines.push(`${new Date(t).toISOString()},130`);
  return call("workout", { key: "p", body: { samples_csv: lines.join("\n") } });
}
const status = async () => (await call("pass", { key: "u", query: { format: "text" } })).body;

test("a week: off the Mac on weekdays earns Saturday, Saturday runs out, Sunday gets the early nights", async () => {
  resetMemory();
  await workoutAt("2026-11-02 06:30");
  await workoutAt("2026-11-04 06:30");
  await workoutAt("2026-11-06 06:30");

  // Mon–Fri: at the Mac 07:00–20:00 and 21:30–22:00 → off 20:00–21:30 (1h 30m) each day.
  // Monday 21:30–21:59 the screen stays lit but untouched after 21:31: only 21:30–21:32 is use.
  for (const d of ["02", "03", "04", "05", "06"]) {
    await mac(`2026-11-${d} 07:00`, `2026-11-${d} 20:00`);
    if (d === "02") await mac("2026-11-02 21:30", "2026-11-02 21:59", t => Math.max(0, (t - sp("2026-11-02 21:31")) / 1000));
    else await mac(`2026-11-${d} 21:30`, `2026-11-${d} 22:00`);
  }
  // Monday earned 1h 30m + 28m (the lit, untouched screen); Tue–Fri 1h 30m each → 7h 58m.
  clock.set(sp("2026-11-06 22:30"));
  assert.match(await status(), /Saturday time banked for Sat, Nov 7: 7h 58m\n  a minute for each minute off the Mac, Mon–Fri 07:00–22:00 \(at most 16h\)/);

  // Saturday: open at 08:00 and use it until it locks.
  let r = await mac("2026-11-07 08:00");
  assert.equal(field(r.body, "saturday_today"), "true");
  assert.equal(field(r.body, "saturday_total_minutes"), String(7 * 60 + 58));
  let cutoff = null;
  for (let i = 1; i <= 9 * 60; i++) {
    r = await mac(sp("2026-11-07 08:00") + i * MIN);
    if (field(r.body, "allowed") === "false") { cutoff = i; break; }
    assert.ok(Number(field(r.body, "lease_seconds")) <= Number(field(r.body, "saturday_left_minutes")) * 60 + 60);
  }
  assert.equal(cutoff, 7 * 60 + 58, "denied exactly when 7h 58m of use is spent (15:58)");
  assert.equal(field(r.body, "reason"), "saturday_time_used");
  assert.match(await status(), /Saturday time today: all used up\n  used 7h 58m of 7h 58m/);

  // Sunday: early nights Mon–Fri off 21:00–21:30 (30m each), Monday also 21:32–22:00 (28m),
  // Saturday 21:00–22:00 off (60m) → 3h 58m. Workouts Mon, Wed, Fri: no streaks.
  clock.set(sp("2026-11-08 09:00"));
  assert.match(await status(), /Sunday time today: 7h 58m left\n  used 0m of 7h 58m\n  4h base \+ 0m brushing \+ 0m streaks \+ 3h 58m early nights/);
  assert.match(await status(), /Saturday time banked for Sat, Nov 14: 0m/);

  // The admin gives back Tuesday night: +30m.
  const f = await call("admin", { key: "a", query: { action: "forgive-night", day: "2026-11-03" } });
  assert.deepEqual([f.status, f.body.forgiven], [200, true]);
  assert.match(await status(), /4h base \+ 0m brushing \+ 0m streaks \+ 4h 28m early nights/);
});

test("the Mac gets the Saturday fields; a 22-minute workout after Nov 1 doesn't count", async () => {
  resetMemory();
  await workoutAt("2026-11-02 06:30", 22);                     // too short from Nov 1
  const r = await mac("2026-11-02 08:00");
  assert.equal(field(r.body, "allowed"), "false");
  assert.equal(field(r.body, "reason"), "workout_noncompliance");
  for (const k of ["saturday", "saturday_limited", "saturday_today", "saturday_total_minutes", "saturday_used_minutes", "saturday_left_minutes"]) {
    assert.ok(new RegExp(`^${k}=`, "m").test(r.body), k);
  }
  assert.equal(field(r.body, "saturday"), "2026-11-07");
  assert.equal(field(r.body, "saturday_total_minutes"), "60");      // off 07:00–08:00 (the first check-in of the day)
});
