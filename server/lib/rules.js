// ─────────────────────────────────────────────────────────────────────────────
// The rules. Pure functions only: no Redis, no network, no clock reads.
// Everything the server decides comes out of decide(), given the same inputs.
// ─────────────────────────────────────────────────────────────────────────────

export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const TIMEZONE = "America/New_York";

// Workout rule, carried over unchanged from Workout Gate v2.
export const RULE = {
  elevatedBpm: 120,   // "elevated" = heart rate above this
  minDurationMin: 20, // a satisfactory workout lasts at least this long…
  minElevatedMin: 5,  // …with at least this many minutes elevated
  maxGapSec: 90,      // readings closer than this belong to the same session
  minSamples: 10,     // ignore tiny bursts of readings
};

// Baselines. Settings may be made stricter immediately; making them looser
// (back toward the baseline) waits LOOSEN_DELAY_HOURS; going past the
// baseline is refused.
export const BASELINE = {
  workoutWindowHours: { value: 48, stricter: "lower", min: 1 },   // max time between workouts
  nightStartHour:     { value: 23, stricter: "lower", min: 12 },  // nightly lockout starts (NY)
  nightEndHour:       { value: 5,  stricter: "higher", max: 12 }, // nightly lockout ends (NY)
};
export const LOOSEN_DELAY_HOURS = 72;

// The Mac keeps a server ALLOW for at most this long without hearing from the
// server again (fail closed). Also never past the next moment the answer flips.
export const LEASE_MAX_SECONDS = 15 * 60;

// Email safeguard: someone at the Mac's screen while denied, for this long.
export const IN_USE_ALERT_MINUTES = 5;
export const IN_USE_REPEAT_MINUTES = 30; // …and again every 30 minutes while it continues
export const IN_USE_GAP_MINUTES = 15; // reports further apart than this start a new episode

// ── time ─────────────────────────────────────────────────────────────────────

export function nyClock(ts) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE, hourCycle: "h23",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ts));
  const g = t => Number(p.find(x => x.type === t).value);
  return { h: g("hour"), m: g("minute"), s: g("second") };
}

export const fmtNY = ts => new Date(ts).toLocaleString("en-US", {
  timeZone: TIMEZONE, weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit",
}) + " NY";

// Is the nightly lockout active at `now`? Window always crosses midnight.
export function nightly(now, policy) {
  const { h, m, s } = nyClock(now);
  const start = policy.nightStartHour, end = policy.nightEndHour;
  const active = h >= start || h < end;
  const secOfDay = h * 3600 + m * 60 + s;
  const until = target => ((target * 3600 - secOfDay) % 86400 + 86400) % 86400;
  return {
    active,
    window: `${pad(start)}:00–${pad(end)}:00 ${TIMEZONE}`,
    // Approximate across a DST change; only used for diagnostics and the lease
    // (the lease is only issued in daytime, when no DST change can happen).
    secondsUntilStart: active ? 0 : until(start),
    secondsUntilEnd: active ? until(end) : 0,
  };
}
const pad = n => String(n).padStart(2, "0");

// ── workouts: heart-rate readings → sessions (Workout Gate v2, unchanged) ────

export function detectSessions(samples) {
  const sorted = samples
    .map(s => ({ t: Date.parse(s.t), bpm: Number(s.bpm) }))
    .filter(s => !isNaN(s.t) && !isNaN(s.bpm))
    .sort((a, b) => a.t - b.t);

  const sessions = [];
  let cur = null;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i], prev = sorted[i - 1];
    const gap = prev ? (s.t - prev.t) / 1000 : Infinity;
    if (!cur || gap > RULE.maxGapSec) {
      cur = { start: s.t, end: s.t, elevatedSec: 0, n: 1, maxBpm: s.bpm };
      sessions.push(cur);
    } else {
      if (prev.bpm > RULE.elevatedBpm) cur.elevatedSec += gap;
      cur.end = s.t;
      cur.n++;
      cur.maxBpm = Math.max(cur.maxBpm, s.bpm);
    }
  }

  return sessions.filter(x => x.n >= RULE.minSamples).map(x => {
    const durationMin = (x.end - x.start) / MIN;
    const elevatedMin = x.elevatedSec / 60;
    return {
      start: new Date(x.start).toISOString(),
      end: new Date(x.end).toISOString(),
      durationMin: round1(durationMin),
      elevatedMin: round1(elevatedMin),
      maxBpm: x.maxBpm,
      pass: isSatisfactory({ durationMin, elevatedMin }),
    };
  });
}
const round1 = x => Math.round(x * 10) / 10;

export const isSatisfactory = s =>
  s.durationMin >= RULE.minDurationMin && s.elevatedMin >= RULE.minElevatedMin;

// The phone re-sends overlapping windows, so the same workout arrives more than
// once. Sessions starting within 2 minutes of each other are the same one; keep
// the longer version. Drop anything older than 90 days.
export function mergeSessions(existing, found, now) {
  const all = [...existing];
  for (const s of found) {
    const i = all.findIndex(x => Math.abs(Date.parse(x.start) - Date.parse(s.start)) < 2 * MIN);
    if (i === -1) all.push(s);
    else if (s.durationMin >= all[i].durationMin) all[i] = s;
  }
  return all
    .filter(x => now - Date.parse(x.end) < 90 * DAY)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function compliance(now, sessions, windowHours) {
  const ended = sessions.filter(s => Date.parse(s.end) <= now);
  const passEnds = ended.filter(isSatisfactory).map(s => Date.parse(s.end));
  const lastPass = passEnds.length ? Math.max(...passEnds) : null;
  const until = lastPass ? lastPass + windowHours * HOUR : null;
  const anyEnds = ended.map(s => Date.parse(s.end));
  return {
    compliant: until !== null && now < until,
    windowHours,
    compliantUntil: iso(until),
    lastSatisfactoryWorkout: iso(lastPass),
    lastAnyWorkout: iso(anyEnds.length ? Math.max(...anyEnds) : null),
  };
}
const iso = t => (t === null || t === undefined ? null : new Date(t).toISOString());

// ── policy: baseline + active values + delayed loosening ─────────────────────
// Stored state: { values: { key: n }, pending: { key: { value, requestedAt, effectiveAt } } }

export function effectivePolicy(state, now) {
  const out = {};
  for (const k of Object.keys(BASELINE)) {
    out[k] = state?.values?.[k] ?? BASELINE[k].value;
    const p = state?.pending?.[k];
    if (p && p.effectiveAt <= now) out[k] = p.value;
  }
  return out;
}

// What kind of change is setting `key` to `value`, given the current policy?
// → { kind: "stricter" | "looser" | "same" } or { error }
export function classifyChange(current, key, value) {
  const b = BASELINE[key];
  if (!b) return { error: `unknown setting '${key}' (known: ${Object.keys(BASELINE).join(", ")})` };
  if (!Number.isInteger(value)) return { error: "value must be a whole number" };
  const lowerIsStricter = b.stricter === "lower";
  const crossesBaseline = lowerIsStricter ? value > b.value : value < b.value;
  if (crossesBaseline) return { error: `refused: ${key}=${value} is looser than the baseline (${b.value})` };
  if (b.min !== undefined && value < b.min) return { error: `${key} must be at least ${b.min}` };
  if (b.max !== undefined && value > b.max) return { error: `${key} must be at most ${b.max}` };
  const cur = current[key];
  if (value === cur) return { kind: "same" };
  const stricter = lowerIsStricter ? value < cur : value > cur;
  return { kind: stricter ? "stricter" : "looser" };
}

// Apply a requested change; returns the new stored state (or { error }).
export function applyChange(state, key, value, now) {
  const current = effectivePolicy(state, now);
  const c = classifyChange(current, key, value);
  if (c.error) return { error: c.error };
  const values = { ...current };          // fold in any matured pending changes
  const pending = {};
  for (const [k, p] of Object.entries(state?.pending || {})) if (p.effectiveAt > now) pending[k] = p;
  delete pending[key];                    // a new request for a key replaces the old one
  if (c.kind === "looser") {
    pending[key] = { value, requestedAt: now, effectiveAt: now + LOOSEN_DELAY_HOURS * HOUR };
  } else {
    values[key] = value;                  // stricter or same: immediate (also cancels a pending loosening)
  }
  return { state: { values, pending }, kind: c.kind };
}

// ── the decision ─────────────────────────────────────────────────────────────

// inputs: { now, policyState, sessions, override, devRecovery }
export function decide({ now, policyState, sessions, override, devRecovery }) {
  const policy = effectivePolicy(policyState, now);
  const night = nightly(now, policy);
  const workout = compliance(now, sessions || [], policy.workoutWindowHours);

  let allowed = true, reason = null;
  if (night.active) { allowed = false; reason = "nightly_lockout"; }
  else if (!workout.compliant) { allowed = false; reason = "workout_noncompliance"; }

  // Development recovery only: honored while DEV_RECOVERY=on on the server.
  const overrideActive = Boolean(devRecovery && override && override.until > now);
  const underlying = { allowed, reason };
  if (overrideActive) { allowed = true; reason = null; }

  // How long the Mac may rely on an ALLOW without asking again.
  let leaseSeconds = 0;
  if (allowed) {
    const limits = [LEASE_MAX_SECONDS];
    if (overrideActive) limits.push(Math.floor((override.until - now) / 1000));
    else {
      limits.push(night.secondsUntilStart);
      limits.push(Math.floor((Date.parse(workout.compliantUntil) - now) / 1000));
    }
    leaseSeconds = Math.max(0, Math.min(...limits));
  }

  return {
    allowed,
    reason,
    now: new Date(now).toISOString(),
    leaseSeconds,
    nightly: night,
    workout,
    policy,
    pendingLoosening: Object.fromEntries(
      Object.entries(policyState?.pending || {}).filter(([, p]) => p.effectiveAt > now)
        .map(([k, p]) => [k, { value: p.value, effectiveAt: iso(p.effectiveAt) }])),
    devOverride: overrideActive
      ? { active: true, until: iso(override.until), wouldOtherwiseBe: underlying }
      : { active: false },
  };
}

// ── email safeguard: track "someone at the screen while denied" ──────────────
// state: { since, lastSeen, lastEmailAt } | null.  Returns { state, sendAlert }.
export function trackInUse(prev, { now, allowed, userPresent }) {
  if (allowed || !userPresent) {
    // An allow ends the episode. A report with nobody at the screen just doesn't extend it.
    if (allowed) return { state: null, sendAlert: false };
    return { state: prev, sendAlert: false };
  }
  let st = prev;
  if (!st || now - st.lastSeen > IN_USE_GAP_MINUTES * MIN) st = { since: now, lastSeen: now, lastEmailAt: null };
  st = { ...st, lastSeen: now };
  const sendAlert = st.lastEmailAt
    ? now - st.lastEmailAt >= IN_USE_REPEAT_MINUTES * MIN
    : now - st.since >= IN_USE_ALERT_MINUTES * MIN;
  if (sendAlert) st.lastEmailAt = now;
  return { state: st, sendAlert };
}
