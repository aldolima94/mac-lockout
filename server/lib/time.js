// Time helpers. Pure: no clock reads. All rules run on New York time.

export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const TIMEZONE = "America/New_York";

export const iso = t => (t === null || t === undefined ? null : new Date(t).toISOString());
const pad = n => String(n).padStart(2, "0");

// Wall-clock parts of `ts` in New York.
export function nyParts(ts) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE, hourCycle: "h23",
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
export function nyLocalToUtc(y, mo, d, h = 0, mi = 0) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(t);
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

export const fmtNY = ts => new Date(ts).toLocaleString("en-US", {
  timeZone: TIMEZONE, weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit",
}) + " NY";

// For the partner's emails (Portuguese, his own time zone).
export const fmtPT = (ts, tz = "America/Sao_Paulo") => new Date(ts).toLocaleString("pt-BR", {
  timeZone: tz, weekday: "short", day: "numeric", month: "short",
  hour: "2-digit", minute: "2-digit",
});
