// Time helpers. Pure: no clock reads. Passes, months and emails run on New York
// time; the nightly lockout and the Sunday bank run on São Paulo time (SP_TZ).

export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const TIMEZONE = "America/New_York";
export const SP_TZ = "America/Sao_Paulo";

export const iso = t => (t === null || t === undefined ? null : new Date(t).toISOString());
const pad = n => String(n).padStart(2, "0");

// Wall-clock parts of `ts` in a time zone (New York unless given).
export function nyParts(ts, tz = TIMEZONE) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ts));
  const g = t => Number(p.find(x => x.type === t).value);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour"), mi: g("minute"), s: g("second") };
}

export function nyClock(ts) {
  const { h, mi, s } = nyParts(ts);
  return { h, m: mi, s };
}

export const nyMonth = ts => { const p = nyParts(ts); return `${p.y}-${pad(p.mo)}`; };
export const nyYear = ts => nyParts(ts).y;
// Day number of the New York calendar date (for "N days apart" rules that ignore DST).
export const nyDayNumber = ts => { const p = nyParts(ts); return Date.UTC(p.y, p.mo - 1, p.d) / 86_400_000; };
export const nyMidnightOfDay = n => { const d = new Date(n * 86_400_000); return nyLocalToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };

// New York wall-clock time → timestamp (handles EST/EDT).
export function nyLocalToUtc(y, mo, d, h = 0, mi = 0, tz = TIMEZONE) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(t, tz);
    t += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return t;
}

// "2026-12-20" (midnight New York), "2026-12-20T08:00" (New York), or a full ISO
// time with Z / offset. → timestamp, or null if unreadable.
export function parseStart(s) {
  s = String(s ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return nyLocalToUtc(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (m) return nyLocalToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]);
  const t = Date.parse(s);
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) && !isNaN(t) ? t : null;
}

// ── São Paulo (nightly lockout, Sunday bank) ─────────────────────────────────
export const spClock = ts => { const { h, mi, s } = nyParts(ts, SP_TZ); return { h, m: mi, s }; };
// Day number of the São Paulo calendar date: days since 1970-01-01.
export const spDayNumber = ts => { const p = nyParts(ts, SP_TZ); return Date.UTC(p.y, p.mo - 1, p.d) / 86_400_000; };
// 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday).
export const weekdayOf = n => (n + 4) % 7;
// Monday of the week (Mon–Sun) that day n is in.
export const mondayOf = n => n - ((weekdayOf(n) + 6) % 7);
// São Paulo wall-clock time on day n → timestamp.
export const spAt = (n, h = 0, mi = 0) => {
  const d = new Date(n * 86_400_000);
  return nyLocalToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, SP_TZ);
};
// Day number ↔ "2026-10-25".
export const dayKey = n => new Date(n * 86_400_000).toISOString().slice(0, 10);
export const dayFromKey = k => Date.parse(`${k}T00:00:00Z`) / 86_400_000;
// "Sun Oct 25"
export const fmtDay = n => new Date(n * 86_400_000).toLocaleDateString("en-US", {
  timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
});
// 270 → "4h 30m", 45 → "45m", 120 → "2h"
export function fmtHM(minutes) {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60), r = m % 60;
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
}

export const fmtNY = ts => new Date(ts).toLocaleString("en-US", {
  timeZone: TIMEZONE, weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit",
}) + " NY";

// For the partner's emails (Portuguese, his own time zone).
export const fmtPT = (ts, tz = "America/Sao_Paulo") => new Date(ts).toLocaleString("pt-BR", {
  timeZone: tz, weekday: "short", day: "numeric", month: "short",
  hour: "2-digit", minute: "2-digit",
});
