// ─────────────────────────────────────────────────────────────────────────────
// Passes. Pure functions only, like rules.js. A pass only ever covers the
// WORKOUT rule. The nightly lockout has no exceptions.
//
// Day pass       request (only while out of compliance, with a reason)
//                → "are you sure?" email dayPassAskMinutes later
//                → confirm from that email (link works CONFIRM_WINDOW_MIN)
//                → active dayPassActivateMinutes after confirming, for dayPassHours.
//                Not confirmed → lapses, not spent. Cancel any time before it's
//                active. A satisfactory workout before it's active cancels it.
// Vacation pass  scheduled ≥ vacationNoticeHours ahead, vacationDays long. Move or
//                cancel before it starts. Only started vacations count toward
//                vacationsPerYear / vacationGapDays.
// Both           no pass may follow another pass without a satisfactory workout
//                after the previous pass started.
//
// Stored as one array of records:
//   day       { id, kind:"day", token, reason, month, requestedAt, askAt, askedAt?,
//               confirmedAt?, activatesAt?, endsAt?, activatedAt?, lapsedAt?,
//               cancelledAt?, cancelledBy? }
//   vacation  { id, kind:"vacation", start, scheduledAt, movedAt?, startedAt?,
//               endsAt?, missedAt?, cancelledAt?, cancelledBy?, noticeSent? }
// Status is derived from timestamps; settlePasses() (run by the scheduler)
// writes the outcome down once it's final.
//
// ctx = { now, policy, workoutEnds }  workoutEnds: end times of satisfactory workouts (≤ now)
// ─────────────────────────────────────────────────────────────────────────────

import { MIN, HOUR, DAY, iso, nyMonth, nyYear, nyDayNumber, nyMidnightOfDay, fmtNY } from "./time.js";

export const CONFIRM_WINDOW_MIN = 120;   // the "are you sure?" link works this long after it's sent
export const REASON_MIN = 3, REASON_MAX = 200;
export const HISTORY_DAYS = 400;         // finished records older than this are dropped

const isDay = p => p.kind === "day";
const isVac = p => p.kind === "vacation";
const replace = (list, old, neu) => list.map(p => (p === old ? neu : p));
const about = m => (m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`);

// ── day pass ─────────────────────────────────────────────────────────────────

export const lapseAt = p => (p.askedAt ?? p.askAt) + CONFIRM_WINDOW_MIN * MIN;

// requested | confirmed | active | used | lapsed | cancelled
export function dayStatus(p, { now, workoutEnds }) {
  if (p.cancelledAt) return "cancelled";
  if (p.lapsedAt) return "lapsed";
  if (!p.activatedAt) {
    // Became compliant (a real workout) before the pass activated → cancelled, not spent.
    const until = p.confirmedAt ? Math.min(now, p.activatesAt) : Math.min(now, lapseAt(p));
    if (workoutEnds.some(t => t >= p.requestedAt && t < until)) return "cancelled";
  }
  if (!p.confirmedAt) return now >= lapseAt(p) ? "lapsed" : "requested";
  if (now < p.activatesAt) return "confirmed";
  return now < p.endsAt ? "active" : "used";
}

// ── vacation pass ────────────────────────────────────────────────────────────

const startedVacations = (passes, except) => passes.filter(v => isVac(v) && v.startedAt && v !== except);

// Limits for a vacation starting at `start` (only vacations that actually started count).
function vacationLimitError(start, passes, policy, except) {
  if (policy.vacationsPerYear <= 0) return "Vacation passes are switched off.";
  const started = startedVacations(passes, except);
  const y = nyYear(start);
  const n = started.filter(v => nyYear(v.startedAt) === y).length;
  if (n >= policy.vacationsPerYear) return `No vacation passes left for ${y} (${n} of ${policy.vacationsPerYear} used).`;
  const gap = policy.vacationGapDays;                 // counted in New York calendar days
  const near = started.find(v => Math.abs(nyDayNumber(v.startedAt) - nyDayNumber(start)) < gap);
  if (near) return `Only one vacation per ${gap} days. Your last one started ${fmtNY(near.startedAt)}; the next can start ${fmtNY(nyMidnightOfDay(nyDayNumber(near.startedAt) + gap))} or later.`;
  return null;
}

// When did the latest pass that was actually used start (before `before`)?
export function lastPassStart(passes, ctx, before = Infinity, except = null) {
  let last = null;
  for (const p of passes) {
    if (p === except) continue;
    let s = null;
    if (isDay(p) && ["active", "used"].includes(dayStatus(p, ctx))) s = p.activatesAt;
    if (isVac(p) && p.startedAt) s = p.startedAt;
    if (s !== null && s < before && (last === null || s > last)) last = s;
  }
  return last;
}
const firstWorkoutAfter = (ctx, t) => ctx.workoutEnds.filter(e => e > t).sort((a, b) => a - b)[0] ?? null;

// scheduled | waiting (needs a workout first) | blocked (limits) | active | used | missed | cancelled
export function vacationView(v, passes, ctx) {
  const { now, policy } = ctx;
  const endsAt = v.endsAt ?? v.start + policy.vacationDays * DAY;
  if (v.cancelledAt) return { status: "cancelled", endsAt };
  if (v.missedAt) return { status: "missed", endsAt };
  if (v.startedAt) return { status: now < endsAt ? "active" : "used", startAt: v.startedAt, endsAt };
  if (now < v.start) return { status: "scheduled", endsAt };

  const limit = vacationLimitError(v.start, passes, policy, v);
  if (limit) return { status: now < endsAt ? "blocked" : "missed", endsAt, blockedBy: limit };
  let startAt = v.start;
  const prev = lastPassStart(passes, ctx, v.start, v);
  if (prev !== null) {
    const w = firstWorkoutAfter(ctx, prev);
    if (w === null) return { status: now < endsAt ? "waiting" : "missed", endsAt, needsWorkoutAfter: prev };
    startAt = Math.max(v.start, w);
  }
  if (startAt >= endsAt) return { status: "missed", endsAt };
  return { status: now < endsAt ? "active" : "used", startAt, endsAt };
}

// ── everything at once: coverage, counts, what's in progress ─────────────────

export function passSummary(passes, ctx) {
  const { now, policy } = ctx;
  passes = passes || [];
  const days = passes.filter(isDay).map(p => ({ p, status: dayStatus(p, ctx) }));
  const vacs = passes.filter(isVac).map(p => ({ p, ...vacationView(p, passes, ctx) }));

  const covers = [
    ...days.filter(x => x.status === "active").map(x => ({ kind: "day_pass", until: x.p.endsAt })),
    ...vacs.filter(x => x.status === "active").map(x => ({ kind: "vacation", until: x.endsAt })),
  ].sort((a, b) => b.until - a.until);
  const ended = [
    ...days.filter(x => x.status === "used").map(x => x.p.endsAt),
    ...vacs.filter(x => x.status === "used").map(x => x.endsAt),
  ];
  const vacEnds = vacs.filter(x => x.status === "active" || x.status === "used").map(x => x.endsAt);

  const month = nyMonth(now), year = nyYear(now);
  const usedThisMonth = days.filter(x => x.p.month === month && !["cancelled", "lapsed"].includes(x.status)).length;
  const startedThisYear = vacs.filter(x => (x.status === "active" || x.status === "used") && nyYear(x.startAt) === year).length;
  const curDay = days.filter(x => ["requested", "confirmed", "active"].includes(x.status)).at(-1);
  const curVac = vacs.filter(x => ["scheduled", "waiting", "blocked", "active"].includes(x.status)).at(-1);

  const last = lastPassStart(passes, ctx, now + 1);
  const needsWorkoutAfter = last !== null && firstWorkoutAfter(ctx, last) === null ? last : null;

  return {
    cover: covers[0] || null,                                  // { kind, until } while a pass covers you
    lastCoverEnd: ended.length ? Math.max(...ended) : null,    // when the last finished pass ended
    lastVacationEnd: vacEnds.length ? Math.max(...vacEnds) : null,
    vacationActive: vacs.some(x => x.status === "active"),
    nextPassNeedsWorkoutAfter: needsWorkoutAfter,
    day: {
      perMonth: policy.dayPassesPerMonth,
      leftThisMonth: Math.max(0, policy.dayPassesPerMonth - usedThisMonth),
      current: curDay ? {
        id: curDay.p.id, status: curDay.status, reason: curDay.p.reason,
        requestedAt: curDay.p.requestedAt, askAt: curDay.p.askAt,
        lapsesAt: curDay.status === "requested" ? lapseAt(curDay.p) : null,
        activatesAt: curDay.p.activatesAt ?? null, endsAt: curDay.p.endsAt ?? null,
      } : null,
    },
    vacation: {
      perYear: policy.vacationsPerYear,
      leftThisYear: Math.max(0, policy.vacationsPerYear - startedThisYear),
      current: curVac ? {
        id: curVac.p.id, status: curVac.status, start: curVac.p.start, startAt: curVac.startAt ?? null,
        endsAt: curVac.endsAt, blockedBy: curVac.blockedBy ?? null, needsWorkoutAfter: curVac.needsWorkoutAfter ?? null,
      } : null,
    },
  };
}

// JSON-friendly copy (ISO times) for the API.
export function summaryForApi(s) {
  const t = o => o && Object.fromEntries(Object.entries(o).map(([k, v]) =>
    [k, /(At|After|^start)$/.test(k) && typeof v === "number" ? iso(v) : v]));
  return {
    cover: s.cover && { kind: s.cover.kind, until: iso(s.cover.until) },
    nextPassNeedsWorkoutAfter: iso(s.nextPassNeedsWorkoutAfter),
    day: { ...s.day, current: t(s.day.current) },
    vacation: { ...s.vacation, current: t(s.vacation.current) },
  };
}

// ── actions (each returns { passes, message } or { error }) ──────────────────

// compliance = the overall answer from decide(): { compliant, until }
export function requestDayPass(passes, ctx, { reason, compliance, id, token }) {
  const { now, policy } = ctx;
  reason = String(reason ?? "").trim();
  if (policy.dayPassesPerMonth <= 0) return { error: "Day passes are switched off." };
  if (reason.length < REASON_MIN) return { error: "Give a short reason (reason=…)." };
  if (reason.length > REASON_MAX) return { error: `Keep the reason under ${REASON_MAX} characters.` };
  if (compliance.compliant) return { error: `You're in compliance until ${fmtNY(compliance.until)}. A day pass can only be requested once you're out of compliance.` };
  const s = passSummary(passes, ctx);
  if (s.day.current) return { error: `You already have a day pass in progress (${s.day.current.status}).` };
  if (s.day.leftThisMonth <= 0) return { error: `No day passes left this month (${policy.dayPassesPerMonth} per month).` };
  if (s.nextPassNeedsWorkoutAfter !== null) return { error: `No pass right after another pass: you need a workout after ${fmtNY(s.nextPassNeedsWorkoutAfter)} first.` };

  const ask = policy.dayPassAskMinutes, act = policy.dayPassActivateMinutes;
  const p = { id, kind: "day", token, reason, month: nyMonth(now), requestedAt: now, askAt: now + ask * MIN };
  return {
    passes: [...passes, p], pass: p,
    message: `Day pass requested. The pass will unlock in about ${about(ask + act)}. ` +
      `In ${about(ask)} you'll get an email asking "are you sure?" Confirm from that email (the link works for ${about(CONFIRM_WINDOW_MIN)}); ` +
      `the pass activates ${about(act)} after you confirm. If you don't confirm, it's not spent. A workout before then cancels it.`,
  };
}

export function confirmDayPass(passes, ctx, token) {
  const { now, policy } = ctx;
  const p = token && passes.find(x => isDay(x) && x.token === token);
  if (!p) return { error: "This link isn't valid." };
  const st = dayStatus(p, ctx);
  if (st !== "requested") return { error: `This day pass can't be confirmed: it's ${st}.` };
  if (now < p.askAt) return { error: "Too early: wait for the email." };
  const activatesAt = now + policy.dayPassActivateMinutes * MIN;
  const q = { ...p, confirmedAt: now, activatesAt, endsAt: activatesAt + policy.dayPassHours * HOUR };
  return {
    passes: replace(passes, p, q), pass: q,
    message: `Confirmed. Your day pass activates ${fmtNY(activatesAt)} and lasts until ${fmtNY(q.endsAt)}. You can still cancel it until it activates.`,
  };
}

// By email token, or (no token) the day pass in progress.
export function cancelDayPass(passes, ctx, token = null) {
  const p = token
    ? passes.find(x => isDay(x) && x.token === token)
    : passes.filter(x => isDay(x) && ["requested", "confirmed"].includes(dayStatus(x, ctx))).at(-1);
  if (!p) return { error: token ? "This link isn't valid." : "No day pass in progress to cancel." };
  const st = dayStatus(p, ctx);
  if (!["requested", "confirmed"].includes(st)) return { error: `Too late to cancel: this day pass is ${st}.` };
  return { passes: replace(passes, p, { ...p, cancelledAt: ctx.now, cancelledBy: "you" }), message: "Day pass cancelled. It wasn't spent." };
}

function checkVacationStart(passes, ctx, start, except) {
  const { now, policy } = ctx;
  if (start === null || start === undefined || isNaN(start)) return "start must be a date like 2026-12-20 (midnight New York) or 2026-12-20T08:00 (New York time).";
  const earliest = now + policy.vacationNoticeHours * HOUR;
  if (start < earliest) return `A vacation must be scheduled at least ${policy.vacationNoticeHours} h ahead (earliest start: ${fmtNY(earliest)}).`;
  return vacationLimitError(start, passes, policy, except);
}
const vacMessage = (verb, start, policy) =>
  `Vacation ${verb}: ${fmtNY(start)} → ${fmtNY(start + policy.vacationDays * DAY)}. You can move or cancel it until it starts.`;

export function scheduleVacation(passes, ctx, { start, id }) {
  const s = passSummary(passes, ctx);
  if (s.vacation.current) return { error: `You already have a vacation ${s.vacation.current.status} (${fmtNY(s.vacation.current.start)}). Move or cancel that one.` };
  const err = checkVacationStart(passes, ctx, start);
  if (err) return { error: err };
  const v = { id, kind: "vacation", start, scheduledAt: ctx.now };
  return { passes: [...passes, v], pass: v, message: vacMessage("scheduled", start, ctx.policy) };
}

const notStartedVacation = (passes, ctx) =>
  passes.filter(v => isVac(v) && ["scheduled", "waiting", "blocked"].includes(vacationView(v, passes, ctx).status)).at(-1);

export function moveVacation(passes, ctx, { start }) {
  const v = notStartedVacation(passes, ctx);
  if (!v) return { error: "No vacation that hasn't started yet to move." };
  const err = checkVacationStart(passes, ctx, start, v);
  if (err) return { error: err };
  const { noticeSent, ...rest } = v;
  return { passes: replace(passes, v, { ...rest, start, movedAt: ctx.now }), message: vacMessage("moved", start, ctx.policy) };
}

export function cancelVacation(passes, ctx) {
  const v = notStartedVacation(passes, ctx);
  if (!v) return { error: "No vacation that hasn't started yet to cancel." };
  return { passes: replace(passes, v, { ...v, cancelledAt: ctx.now, cancelledBy: "you" }), message: "Vacation cancelled. It doesn't count toward any limit." };
}

// ── scheduler: write down final outcomes, and say what to email about ───────

export function settlePasses(passes, ctx) {
  const { now } = ctx;
  let out = (passes || []).map(p => ({ ...p }));
  const notices = [];

  for (const v of out.filter(isVac)) {            // vacations first: a starting vacation cancels a pending day pass
    const view = vacationView(v, out, ctx);
    if ((view.status === "active" || view.status === "used") && !v.startedAt) {
      v.startedAt = view.startAt; v.endsAt = view.endsAt;
      notices.push({ type: "vacation-started", pass: v });
    } else if (view.status === "missed" && !v.missedAt && !v.cancelledAt) {
      v.missedAt = now;
      notices.push({ type: "vacation-missed", pass: v });
    } else if ((view.status === "waiting" || view.status === "blocked") && v.noticeSent !== view.status) {
      v.noticeSent = view.status;
      notices.push({ type: `vacation-${view.status}`, pass: v, view });
    }
  }

  const vacStarts = out.filter(v => isVac(v) && v.startedAt).map(v => v.startedAt);
  for (const p of out.filter(isDay)) {
    if (p.cancelledAt || p.lapsedAt) continue;
    const st = dayStatus(p, ctx);
    if (!p.activatedAt && st !== "cancelled" && st !== "lapsed" &&
        vacStarts.some(t => t >= p.requestedAt && t <= now && (!p.activatesAt || t < p.activatesAt))) {
      Object.assign(p, { cancelledAt: now, cancelledBy: "vacation" });
      notices.push({ type: "day-cancelled-vacation", pass: p });
    } else if (st === "cancelled") {
      Object.assign(p, { cancelledAt: now, cancelledBy: "workout" });
      notices.push({ type: "day-cancelled-workout", pass: p });
    } else if (st === "lapsed") {
      p.lapsedAt = lapseAt(p);
      notices.push({ type: "day-lapsed", pass: p });
    } else if ((st === "active" || st === "used") && !p.activatedAt) {
      p.activatedAt = p.activatesAt;
      notices.push({ type: "day-active", pass: p });
    }
  }

  const old = now - HISTORY_DAYS * DAY;
  out = out.filter(p => {
    const created = p.requestedAt ?? p.scheduledAt;
    const finished = p.cancelledAt || p.lapsedAt || p.missedAt || (p.endsAt && p.endsAt < now);
    return !(created < old && finished);
  });
  return { passes: out, notices };
}

// Day passes whose "are you sure?" email is due.
export const asksDue = (passes, ctx) =>
  (passes || []).filter(p => isDay(p) && !p.askedAt && ctx.now >= p.askAt && dayStatus(p, ctx) === "requested");

// For escalation: every day-pass request, and whether it's still pending.
export const dayRequests = (passes, ctx) =>
  (passes || []).filter(isDay).map(p => ({ at: p.requestedAt, pending: ["requested", "confirmed"].includes(dayStatus(p, ctx)) }));
