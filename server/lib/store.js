// Redis, keys, auth, event log, email. Everything impure lives here.

import { Redis } from "@upstash/redis";
import nodemailer from "nodemailer";
import { randomBytes } from "node:crypto";

// All keys are prefixed so this can share an Upstash database with Workout Gate.
const P = "ml:";
export const K = {
  policy: P + "policy", sessions: P + "sessions", override: P + "override",
  last: P + "lastDecision", inUse: P + "inUse", macLast: P + "macLastSeen",
  phoneLast: P + "phoneLastSeen", events: P + "events",
  passes: P + "passes", escalation: P + "escalation", vacAlarm: P + "vacationAlarm",
  mailFail: P + "mailFailed", lock: P + "lock",
};

let _redis;
export const redis = () => (_redis ||= globalThis.__TEST_REDIS__ || Redis.fromEnv());

export const devRecovery = () => process.env.DEV_RECOVERY === "on";

// ── keys ─────────────────────────────────────────────────────────────────────
//   MAC_KEY    the Mac daemon          PHONE_KEY  the workout Shortcut
//   USER_KEY   you: status + passes    ADMIN_KEY  your partner: policy changes, admin actions
//   CRON_KEY   the scheduler (/api/tick)
function given(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return String(req.query?.key || "");
}
export function hasKey(req, ...names) {
  const g = given(req);
  return names.some(name => Boolean(process.env[name]) && g === process.env[name]);
}
export function deny(res) {
  res.status(401).json({ error: "unauthorized" });
}

export function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body !== "string") return req.body;
  try { return JSON.parse(req.body); } catch { return Object.fromEntries(new URLSearchParams(req.body)); }
}

// Where links in emails point.
export const appUrl = req => (process.env.APP_URL ||
  `https://${req.headers["x-forwarded-host"] || req.headers.host}`).replace(/\/$/, "");

export const newId = () => randomBytes(6).toString("hex");
export const newToken = () => randomBytes(18).toString("base64url");

// ── loading everything decide() needs, in one round trip ─────────────────────
export async function loadState() {
  const [policyState, sessions, override, last, inUse, macLast, passes, escalation, vacAlarm] =
    await redis().mget(K.policy, K.sessions, K.override, K.last, K.inUse, K.macLast, K.passes, K.escalation, K.vacAlarm);
  return { policyState, sessions: sessions || [], override, last, inUse, macLast, passes: passes || [], escalation, vacAlarm };
}

// One writer at a time for the passes list (the scheduler vs. your requests).
export async function withLock(fn) {
  for (let i = 0; i < 50; i++) {
    if (await redis().set(K.lock, "1", { nx: true, px: 25_000 })) {
      try { return await fn(); } finally { await redis().del(K.lock); }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("busy — try again in a few seconds");
}

// ── event log (last 300) ─────────────────────────────────────────────────────
export async function logEvent(e) {
  await redis().lpush(K.events, JSON.stringify({ at: new Date().toISOString(), ...e }));
  await redis().ltrim(K.events, 0, 299);
}

// ── email (Gmail app password, as in Workout Gate) ───────────────────────────
// A failed send is remembered; the scheduler reports it to its Healthchecks check.
export const myEmail = () => process.env.ALERT_EMAIL || process.env.GMAIL_USER;
export const partner = () => ({
  email: process.env.PARTNER_EMAIL || "",
  name: process.env.PARTNER_NAME || "amigo",
  tz: process.env.PARTNER_TIMEZONE || "America/Sao_Paulo",
});

let transport;
export async function sendMail(to, subject, text) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    await logEvent({ type: "email-skipped", subject, why: "GMAIL_USER / GMAIL_APP_PASSWORD not set" });
    return false;
  }
  transport ||= globalThis.__TEST_MAILER__ || nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "") },
  });
  try {
    await transport.sendMail({ from: `Mac Lockout <${process.env.GMAIL_USER}>`, to, subject, text });
    await logEvent({ type: "email", subject, to });
    return true;
  } catch (e) {
    const error = String(e?.message || e);
    await redis().set(K.mailFail, { at: Date.now(), subject, error });
    await logEvent({ type: "email-failed", subject, to, error });
    return false;
  }
}
export const mailMe = m => sendMail(myEmail(), m.subject, m.text);
export async function mailPartner(m) {
  const p = partner();
  if (!p.email) { await logEvent({ type: "email-skipped", subject: m.subject, why: "PARTNER_EMAIL not set" }); return false; }
  return sendMail(p.email, m.subject, m.text);
}
// { me, partner } → you get yours; with to === "both" your partner gets his.
export async function mailTo(to, m) {
  const a = await mailMe(m.me || m);
  if (to !== "both") return a;
  const b = await mailPartner(m.partner);
  return a && b;
}
