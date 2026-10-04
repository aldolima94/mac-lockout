// End-to-end through the real handlers: in-memory Redis, captured emails and
// Healthchecks pings, and a fake clock. Walks the whole day-pass chain,
// escalation to the partner, a vacation, and the in-use emails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, emails, pings, mailer, resetMemory } from "./memory.js";
import { nyLocalToUtc } from "../lib/time.js";

Object.assign(process.env, {
  MAC_KEY: "m", PHONE_KEY: "p", USER_KEY: "u", ADMIN_KEY: "a", CRON_KEY: "c",
  GMAIL_USER: "randy@example.com", GMAIL_APP_PASSWORD: "x",
  PARTNER_EMAIL: "friend@example.com", PARTNER_NAME: "Zé",
  MAC_HEALTHCHECK_URL: "http://hc.test/mac", CRON_HEALTHCHECK_URL: "http://hc.test/cron",
  APP_URL: "https://app.test",
});
const api = {};
for (const n of ["permission", "workout", "policy", "admin", "events", "pass", "confirm", "tick"]) api[n] = (await import(`../api/${n}.js`)).default;

const MIN = 60_000, HOUR = 60 * MIN;
async function call(name, { key, query = {}, body, method = body ? "POST" : "GET" } = {}) {
  let status = 200, out, headers = {};
  const res = {
    status(s) { status = s; return res; },
    setHeader(k, v) { headers[k] = v; },
    json(o) { out = o; return res; },
    send(s) { out = s; return res; },
  };
  await api[name]({ method, headers: key ? { authorization: `Bearer ${key}` } : {}, query, body }, res);
  return { status, body: out, headers };
}
const tick = () => call("tick", { key: "c" });
async function ticks(ms) { for (let t = 0; t < ms; t += 5 * MIN) { clock.advance(5 * MIN); await tick(); } }
const mailsSince = i => emails.slice(i).map(e => `${e.to === "friend@example.com" ? "partner" : "me"}: ${e.subject}`);

function workoutBody(endTs) {
  const lines = [];
  for (let t = endTs - 25 * MIN; t <= endTs; t += 30_000) lines.push(`${new Date(t).toISOString()},130`);
  return { samples_csv: lines.join("\n") };
}

test("keys: user key reads and requests passes; only the admin key changes rules", async () => {
  resetMemory(); clock.set(nyLocalToUtc(2026, 10, 5, 12, 0));
  assert.equal((await call("pass", { key: "m" })).status, 401);
  assert.equal((await call("pass", { key: "u" })).status, 200);
  assert.equal((await call("permission", { key: "u" })).status, 200);
  assert.equal((await call("events", { key: "u" })).status, 200);
  assert.equal((await call("policy", { key: "u", query: { set: "dayPassesPerMonth", value: "1" } })).status, 403);
  assert.equal((await call("policy", { key: "a", query: { set: "dayPassesPerMonth", value: "1" } })).body.kind, "stricter");
  assert.equal((await call("admin", { key: "u", query: { action: "test-email" } })).status, 401);
  assert.equal((await call("tick", { key: "u" })).status, 401);
  const i = emails.length;
  await call("admin", { key: "a", query: { action: "test-email" } });
  assert.deepEqual(mailsSince(i), ["me: Mac Lockout: test email", "partner: Teste: avisos do Mac Lockout do Randy"]);
});

test("the whole story", async () => {
  resetMemory(); pings.length = 0;
  const t0 = nyLocalToUtc(2026, 10, 5, 12, 0);       // Mon Oct 5, noon New York
  clock.set(t0 - 3 * 24 * HOUR);
  await call("workout", { key: "p", body: workoutBody(Date.now()) });   // last workout Oct 2 noon → compliant till Oct 4 noon
  clock.set(t0);

  // Out of compliance → the first email is a warning, to me only.
  let i = emails.length;
  await tick();
  assert.deepEqual(mailsSince(i), ["me: Mac Lockout: you're out of workout compliance"]);
  assert.match(emails.at(-1).text, /Zé gets an email/);
  assert.ok(pings.includes("http://hc.test/cron"));

  // Request a day pass from the phone.
  let r = await call("pass", { key: "u", query: { action: "day", reason: "", format: "text" } });
  assert.equal(r.status, 400);
  r = await call("pass", { key: "u", query: { action: "day", reason: "flu", format: "text" } });
  assert.equal(r.status, 200);
  assert.match(r.body, /The pass will unlock in about 1 hour/);
  assert.match(r.body, /Day passes: 1 of 2 left this month — requested/);

  // 30 min later: "are you sure?" email with a link.
  i = emails.length;
  await ticks(30 * MIN);
  assert.deepEqual(mailsSince(i), ["me: Mac Lockout: are you sure you want a day pass?"]);
  const link = emails.at(-1).text.match(/https:\/\/app\.test\/api\/confirm\?t=(\S+)/);
  assert.ok(link, emails.at(-1).text);
  const token = link[1];

  // Opening the link only shows the question; the button confirms.
  r = await call("confirm", { query: { t: token } });
  assert.match(r.body, /Are you sure\?/);
  assert.match(r.body, /flu/);
  r = await call("confirm", { method: "POST", body: `t=${encodeURIComponent(token)}&do=confirm` });
  assert.match(r.body, /Confirmed/);
  const confirmedAt = Date.now();

  // Still locked until 30 min after confirming; then allowed via the day pass.
  clock.advance(29 * MIN);
  assert.equal((await call("permission", { key: "u" })).body.allowed, false);
  i = emails.length;
  await ticks(5 * MIN);
  const p = (await call("permission", { key: "m", query: { format: "text", user_present: "1" } })).body;
  assert.match(p, /^allowed=true$/m);
  assert.match(p, /^compliant_via=day_pass$/m);
  assert.match(p, /^day_pass=active$/m);
  assert.match(p, /^day_passes_left=1$/m);
  assert.deepEqual(mailsSince(i), [`me: Mac Lockout: day pass active until ${new Date(confirmedAt + 30 * MIN + 24 * HOUR).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} NY`]);

  // The nightly lockout still applies during the pass.
  clock.set(nyLocalToUtc(2026, 10, 5, 23, 30));
  assert.equal((await call("permission", { key: "u" })).body.reason, "nightly_lockout");

  // Pass ends (Oct 6 ~13:05). No other pass without a workout first.
  clock.set(confirmedAt + 30 * MIN + 24 * HOUR + MIN);
  r = await call("pass", { key: "u", query: { action: "day", reason: "again" } });
  assert.match(r.body.error, /No pass right after another pass/);

  // Escalation: warning now, partner 24 h later (in Portuguese), repeated every 24 h.
  i = emails.length;
  await ticks(10 * MIN);
  assert.deepEqual(mailsSince(i), ["me: Mac Lockout: you're out of workout compliance"]);
  i = emails.length;
  await ticks(24 * HOUR);
  assert.deepEqual(mailsSince(i), [
    "me: Mac Lockout: Zé has been told you're out of compliance",
    "partner: Randy está sem treinar",
  ]);
  assert.match(emails.at(-1).text, /Oi Zé/);
  i = emails.length;
  await ticks(24 * HOUR);
  assert.equal(mailsSince(i).filter(s => s.startsWith("partner")).length, 1);

  // A workout → back on track; the partner is told.
  r = await call("workout", { key: "p", body: workoutBody(Date.now() - MIN) });
  assert.equal(r.body.compliance.compliant, true);
  i = emails.length;
  await tick();
  assert.deepEqual(mailsSince(i), [
    "me: Mac Lockout: back in compliance (Zé has been told)",
    "partner: O Randy voltou a cumprir o combinado",
  ]);

  // Vacation: scheduled from the phone; during it the Mac's shutdown alarm stays quiet.
  const start = new Date(Date.now() + 2 * 24 * HOUR).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  r = await call("pass", { key: "u", query: { action: "vacation", start: "tomorrow", format: "text" } });
  assert.equal(r.status, 400);
  r = await call("pass", { key: "u", query: { action: "vacation", start, format: "text" } });
  assert.match(r.body, /Vacation scheduled/);
  assert.match(r.body, /Vacation: 4 of 4 left this year; scheduled/);
  await call("permission", { key: "m", query: { user_present: "0" } });   // Mac seen once, then shut down
  clock.set(nyLocalToUtc(...start.split("-").map(Number), 12, 0) + 2 * 24 * HOUR);   // day 3, workout window over
  pings.length = 0; i = emails.length;
  await ticks(10 * MIN);
  assert.ok(mailsSince(i).some(s => /vacation pass active/.test(s)), mailsSince(i).join("; "));
  assert.ok(pings.includes("http://hc.test/mac"), "vacation keeps the Mac check green");
  assert.equal((await call("permission", { key: "u" })).body.compliance.via, "vacation");
  // …5 days later it ends; 12 h after that, the alarm is re-armed once.
  clock.set(nyLocalToUtc(...start.split("-").map(Number)) + 5 * 24 * HOUR + 11 * HOUR);
  pings.length = 0;
  await ticks(2 * HOUR);
  assert.equal(pings.filter(u => u === "http://hc.test/mac/start").length, 1);
  assert.ok(pings.indexOf("http://hc.test/mac") < pings.indexOf("http://hc.test/mac/start"));

  // Mac in use while denied: first email to me, later ones to both.
  i = emails.length;
  clock.set(nyLocalToUtc(2026, 11, 2, 23, 10));
  for (let m = 0; m < 40; m++) { await call("permission", { key: "m", query: { user_present: "1", mode: "enforce" } }); clock.advance(MIN); }
  assert.deepEqual(mailsSince(i).filter(s => /in use|usando/.test(s)), [
    "me: Mac Lockout: MacBook in use while denied (nightly_lockout)",
    "me: Mac Lockout: MacBook in use while denied (nightly_lockout)",
    "partner: Randy está usando o Mac quando deveria estar bloqueado",
  ]);

  // A failed email shows up as /fail on the scheduler's Healthchecks check.
  mailer.fail = true; pings.length = 0;
  await call("admin", { key: "a", query: { action: "test-email" } });
  mailer.fail = false;
  await tick();
  assert.ok(pings.includes("http://hc.test/cron/fail"), pings.join(", "));
  pings.length = 0;
  await tick();
  assert.ok(pings.includes("http://hc.test/cron"));
});

test("a lapsed request doesn't buy time; cancel works from the email page", async () => {
  resetMemory();
  const t0 = nyLocalToUtc(2026, 10, 5, 12, 0);
  clock.set(t0);
  await tick();                                                   // warning (no workouts ever)
  clock.advance(22 * HOUR);
  await call("pass", { key: "u", query: { action: "day", reason: "tired" } });
  let i = emails.length;
  await ticks(3 * HOUR);                                          // 24 h mark passes while pending → held
  const sent = mailsSince(i);
  assert.ok(sent.includes("me: Mac Lockout: are you sure you want a day pass?"));
  assert.ok(sent.includes("me: Mac Lockout: day pass request lapsed (not spent)"));
  assert.ok(sent.includes("partner: Randy está sem treinar"), sent.join("; "));   // overdue → sent right after the lapse
  // second request in the same stretch: cancel it from the email page
  await call("pass", { key: "u", query: { action: "day", reason: "tired again" } });
  await ticks(35 * MIN);
  const token = emails.findLast(e => /are you sure/.test(e.subject)).text.match(/confirm\?t=(\S+)/)[1];
  const r = await call("confirm", { method: "POST", body: { t: token, do: "cancel" } });
  assert.match(r.body, /Day pass cancelled/);
  const s = await call("pass", { key: "u" });
  assert.equal(s.body.passes.day.leftThisMonth, 2);
  assert.equal(s.body.passes.day.current, null);
});
