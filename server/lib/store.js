// Redis, keys, event log, email. Everything impure lives here.

import { Redis } from "@upstash/redis";
import nodemailer from "nodemailer";

// All keys are prefixed so this can share an Upstash database with Workout Gate.
const P = "ml:";
export const K = {
  policy: P + "policy", sessions: P + "sessions", override: P + "override",
  last: P + "lastDecision", inUse: P + "inUse", macLast: P + "macLastSeen",
  phoneLast: P + "phoneLastSeen", events: P + "events",
};

let _redis;
export const redis = () => (_redis ||= globalThis.__TEST_REDIS__ || Redis.fromEnv());

export const devRecovery = () => process.env.DEV_RECOVERY === "on";

// ── keys (one per device + an admin key) ─────────────────────────────────────
function given(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return String(req.query?.key || "");
}
export function hasKey(req, name) {
  const k = process.env[name];
  return Boolean(k) && given(req) === k;
}
export function deny(res) {
  res.status(401).json({ error: "unauthorized" });
}

export function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
}

// ── loading everything decide() needs, in one round trip ─────────────────────
export async function loadState() {
  const [policyState, sessions, override, last, inUse, macLast] =
    await redis().mget(K.policy, K.sessions, K.override, K.last, K.inUse, K.macLast);
  return { policyState, sessions: sessions || [], override, last, inUse, macLast };
}

// ── event log (last 300) ─────────────────────────────────────────────────────
export async function logEvent(e) {
  await redis().lpush(K.events, JSON.stringify({ at: new Date().toISOString(), ...e }));
  await redis().ltrim(K.events, 0, 299);
}

// ── email (Gmail app password, as in Workout Gate) ───────────────────────────
let transport;
export async function sendMail(subject, text) {
  const to = process.env.ALERT_EMAIL || process.env.GMAIL_USER;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    await logEvent({ type: "email-skipped", subject, why: "GMAIL_USER / GMAIL_APP_PASSWORD not set" });
    return false;
  }
  transport ||= globalThis.__TEST_MAILER__ || nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "") },
  });
  await transport.sendMail({ from: `Mac Lockout <${process.env.GMAIL_USER}>`, to, subject, text });
  await logEvent({ type: "email", subject, to });
  return true;
}
