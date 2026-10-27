// Activity trail + admin helpers. Logging is fire-and-forget: it can never slow down or break a normal request.
import { prisma } from './db.js';

/* ---------- action catalogue ---------- */
export const ACTIONS = [
  'login', 'jd_extracted', 'jd_saved', 'jd_deleted',
  'resume_analyzed', 'resume_failed', 'resume_masked', 'mask_failed', 'mask_edited', 'pdf_downloaded',
  'shortlisted', 'unshortlisted', 'candidate_deleted', 'settings_updated', 'logo_changed', 'admin_wipe',
];

// Columns of the weekly / monthly report (each = one or more actions)
export const GROUPS = {
  jds: ['jd_extracted'],
  analyzed: ['resume_analyzed'],
  masked: ['resume_masked'],
  mask_failed: ['mask_failed'],
  pdfs: ['pdf_downloaded'],
  shortlisted: ['shortlisted'],
  deleted: ['candidate_deleted', 'jd_deleted'],
  logins: ['login'],
};
const GROUP_OF = Object.fromEntries(Object.entries(GROUPS).flatMap(([g, acts]) => acts.map(a => [a, g])));
export const emptyCounts = () => ({ ...Object.fromEntries(Object.keys(GROUPS).map(g => [g, 0])), total: 0 });
export function addCount(counts, action, n = 1) {
  counts.total += n;
  const g = GROUP_OF[action]; if (g) counts[g] += n;
}

/* ---------- writing ---------- */
const row = (userId, action, o = {}) => ({ user_id: userId, action, entity: o.entity ?? null, entity_id: o.entityId ?? null, label: o.label ?? null, detail: o.detail ?? undefined });

export function logActivity(userId, action, o) {
  if (!userId) return;
  prisma.activityLog.create({ data: row(userId, action, o) }).catch(e => console.error('[activity]', e.message));
}
export function logActivities(userId, action, list) {        // many rows of the same action (bulk delete)
  if (!userId || !list.length) return;
  prisma.activityLog.createMany({ data: list.map(o => row(userId, action, o)) }).catch(e => console.error('[activity]', e.message));
}

/* ---------- admin identity ---------- */
const ADMINS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
export const isAdminEmail = email => !!email && ADMINS.includes(String(email).toLowerCase());

/* ---------- time zone (reports are bucketed by LOCAL day, default India) ---------- */
let TZ = process.env.ADMIN_TZ || 'Asia/Kolkata';
let dtf;
try { dtf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
catch { TZ = 'UTC'; dtf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
export const TIMEZONE = TZ;

const parts = ms => Object.fromEntries(dtf.formatToParts(ms).map(p => [p.type, p.value]));
export const localDate = ms => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const offsetAt = ms => { const p = parts(ms); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000; };
const iso = d => d.toISOString().slice(0, 10);
const ymd = s => s.split('-').map(Number);
export const addDays = (s, n) => { const [y, m, d] = ymd(s); return iso(new Date(Date.UTC(y, m - 1, d + n))); };
const addMonths = (s, n) => { const [y, m] = ymd(s); return iso(new Date(Date.UTC(y, m - 1 + n, 1))); };
const weekStart = s => { const [y, m, d] = ymd(s); return addDays(s, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7)); };   // Monday
const monthStart = s => s.slice(0, 8) + '01';
/** 'YYYY-MM-DD' (local) -> UTC milliseconds of that local midnight */
export function dayStart(s) {
  const [y, m, d] = ymd(s), guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}
export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));

/** Date-range filter for created_at from two local dates (inclusive). */
export function rangeWhere(from, to) {
  const w = {};
  if (isDate(from)) w.gte = new Date(dayStart(from));
  if (isDate(to)) w.lt = new Date(dayStart(addDays(to, 1)));
  return Object.keys(w).length ? { created_at: w } : {};
}

/** Empty daily / weekly (Mon-Sun) / monthly periods, newest first: [{ key, from, to }] in local dates. */
export function periodList(period, count) {
  const today = localDate(Date.now()), list = [];
  const first = { day: s => s, week: weekStart, month: monthStart }[period] || weekStart;
  const step = { day: (s, n) => addDays(s, n), week: (s, n) => addDays(s, 7 * n), month: addMonths }[period] || ((s, n) => addDays(s, 7 * n));
  let start = first(today);
  for (let i = 0; i < count; i++) { list.push({ key: start, from: start, to: addDays(step(start, 1), -1) }); start = step(start, -1); }
  return list;
}
/** Key of the period a timestamp falls in (matches periodList keys). */
export const periodKey = (ms, period) => { const d = localDate(ms); return period === 'day' ? d : period === 'month' ? monthStart(d) : weekStart(d); };

/** Weekly (Mon-Sun) or monthly buckets, newest first, empty periods included. */
export async function buildReport(userId, period, count) {
  const wk = period === 'week';
  const list = periodList(wk ? 'week' : 'month', count).map(b => ({ ...b, counts: emptyCounts() }));
  const byKey = new Map(list.map(b => [b.key, b]));
  const rows = await prisma.activityLog.findMany({
    where: { user_id: userId, created_at: { gte: new Date(dayStart(list[list.length - 1].from)) } },
    select: { action: true, created_at: true }, take: 50000,
  });
  for (const r of rows) {
    const d = localDate(r.created_at.getTime());
    const b = byKey.get(wk ? weekStart(d) : monthStart(d));
    if (b) addCount(b.counts, r.action);
  }
  return list;
}
