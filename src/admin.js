// Admin portal API (mounted at /admin-api behind requireAdminAuth). Only emails listed in ADMIN_EMAILS can sign in.
// Admins see activity METADATA only (who did what, when, file names, scores) - never resume text or masked text.
import express from 'express';
import { prisma, getSettings } from './db.js';
import { candView, labelOf, pad, safeName, fileExt, MIME } from './shared.js';
import { buildAnalysisPdf } from './analysispdf.js';
import { buildPdf } from './maskpdf.js';
import { ACTIONS, emptyCounts, addCount, buildReport, rangeWhere, isDate, logActivity, TIMEZONE } from './activity.js';

const USER_PUB = { id: true, name: true, email: true, picture: true, created_at: true, last_login: true };
const fmtDT = d => new Date(d).toLocaleString('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

const SHORT_SEL = {
  id: true, name: true, file_name: true, score: true, req_hit: true, req_total: true, analysis: true, shortlisted: true, shortlisted_at: true,
  created_at: true, mask_status: true, jd_id: true, user_id: true,
  jd: { select: { id: true, title: true, client: true } }, user: { select: { id: true, name: true, email: true, picture: true } },
};
const SHORT_ORDER = [{ shortlisted_at: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
const slim = c => ({ ...candView(c), analysis: undefined });           // list rows: no analysis blob (fetched on "View analysis")
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };

export function adminRouter(h, bad) {
  const r = express.Router();

  const uid = req => { const n = Number(req.params.id); if (!Number.isInteger(n)) throw bad('Invalid user.'); return n; };
  const userOr404 = async id => { const u = await prisma.user.findUnique({ where: { id }, select: USER_PUB }); if (!u) throw bad('User not found', 404); return u; };

  // Activity filter shared by the screen and the CSV export
  const actWhere = (req, userId) => {
    const { action, from, to } = req.query;
    return {
      ...(userId ? { user_id: userId } : req.query.user_id ? { user_id: Number(req.query.user_id) } : {}),
      ...(ACTIONS.includes(action) ? { action } : {}),
      ...rangeWhere(from, to),
    };
  };

  /* Dashboard: headline numbers + every user with their totals */
  r.get('/overview', h(async (req, res) => {
    const now = Date.now(), d7 = new Date(now - 7 * 864e5), d30 = new Date(now - 30 * 864e5);
    const [users, groups, a7, a30, active7, shortTotal, shortRecent] = await Promise.all([
      prisma.user.findMany({ select: USER_PUB, orderBy: { last_login: 'desc' } }),
      prisma.activityLog.groupBy({ by: ['user_id', 'action'], _count: { _all: true }, _max: { created_at: true } }),
      prisma.activityLog.count({ where: { created_at: { gte: d7 } } }),
      prisma.activityLog.count({ where: { created_at: { gte: d30 } } }),
      prisma.activityLog.groupBy({ by: ['user_id'], where: { created_at: { gte: d7 } } }),
      prisma.candidate.count({ where: { shortlisted: true } }),
      prisma.candidate.findMany({ where: { shortlisted: true }, select: SHORT_SEL, orderBy: SHORT_ORDER, take: 10 }),
    ]);
    const per = new Map();
    for (const g of groups) {
      const e = per.get(g.user_id) || { counts: emptyCounts(), last: null };
      addCount(e.counts, g.action, g._count._all);
      const t = g._max.created_at; if (t && (!e.last || t > e.last)) e.last = t;
      per.set(g.user_id, e);
    }
    res.json({
      tz: TIMEZONE, actions: ACTIONS,
      totals: { users: users.length, active_7d: active7.length, actions_7d: a7, actions_30d: a30, shortlisted: shortTotal },
      shortlisted: shortRecent.map(slim),
      users: users.map(u => ({ ...u, counts: per.get(u.id)?.counts || emptyCounts(), last_activity: per.get(u.id)?.last || null })),
    });
  }));

  /* Activity log (all users, or one with ?user_id=) - newest first, cursor paging */
  r.get('/activity', h(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200), cursor = Number(req.query.cursor);
    const rows = await prisma.activityLog.findMany({
      where: actWhere(req), orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1,
      ...(Number.isInteger(cursor) && cursor > 0 ? { cursor: { id: cursor }, skip: 0 } : {}),
      include: { user: { select: { id: true, name: true, email: true, picture: true } } },
    });
    const more = rows.length > limit;
    res.json({ items: rows.slice(0, limit), next_cursor: more ? rows[limit].id : null });
  }));

  /* One user's dedicated dashboard */
  r.get('/users/:id', h(async (req, res) => {
    const id = uid(req), user = await userOr404(id);
    const [groups, jds, resumes, masked, shortlisted, shortRows] = await Promise.all([
      prisma.activityLog.groupBy({ by: ['action'], where: { user_id: id }, _count: { _all: true } }),
      prisma.jd.count({ where: { user_id: id } }), prisma.candidate.count({ where: { user_id: id } }),
      prisma.candidate.count({ where: { user_id: id, mask_status: 'masked' } }), prisma.candidate.count({ where: { user_id: id, shortlisted: true } }),
      prisma.candidate.findMany({ where: { user_id: id, shortlisted: true }, select: SHORT_SEL, orderBy: SHORT_ORDER, take: 200 }),
    ]);
    const counts = emptyCounts(); groups.forEach(g => addCount(counts, g.action, g._count._all));
    res.json({ user, counts, stored: { jds, resumes, masked, shortlisted }, shortlisted: shortRows.map(slim), tz: TIMEZONE, actions: ACTIONS });
  }));

  /* Weekly (Mon-Sun) / monthly report for one user */
  r.get('/users/:id/report', h(async (req, res) => {
    const id = uid(req); await userOr404(id);
    const period = req.query.period === 'month' ? 'month' : 'week';
    const count = Math.min(Math.max(Number(req.query.count) || (period === 'week' ? 12 : 12), 1), period === 'week' ? 104 : 36);
    res.json({ period, tz: TIMEZONE, buckets: await buildReport(id, period, count) });
  }));

  /* Download one user's activity (respects the same filters) as CSV */
  r.get('/users/:id/activity.csv', h(async (req, res) => {
    const id = uid(req), user = await userOr404(id);
    const rows = await prisma.activityLog.findMany({ where: actWhere(req, id), orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 20000 });
    const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const lines = [['Date/time (' + TIMEZONE + ')', 'User', 'Email', 'Action', 'Item', 'Details'].map(cell).join(',')];
    for (const x of rows) lines.push([fmtDT(x.created_at), user.name || '', user.email, x.action, x.label || '', x.detail ? JSON.stringify(x.detail) : ''].map(cell).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="activity-user-${id}${isDate(req.query.from) ? '-from-' + req.query.from : ''}${isDate(req.query.to) ? '-to-' + req.query.to : ''}.csv"` });
    res.send('\uFEFF' + lines.join('\r\n'));
  }));

  /* Complete deletion of a user's JDs + candidates (moved here from the user's Settings page). The audit trail is kept. */
  r.post('/users/:id/wipe', h(async (req, res) => {
    const id = uid(req), user = await userOr404(id);
    if (req.body?.confirm !== 'DELETE') throw bad('Confirmation missing.');
    const cands = await prisma.candidate.deleteMany({ where: { user_id: id } });
    const jds = await prisma.jd.deleteMany({ where: { user_id: id } });
    logActivity(id, 'admin_wipe', { detail: { resumes: cands.count, jds: jds.count, by: req.admin.email } });
    res.json({ ok: true, resumes: cands.count, jds: jds.count });
  }));

  /* Remove the user (their e-mail) completely: account, settings, JDs, resumes AND activity history (all cascade). */
  r.delete('/users/:id', h(async (req, res) => {
    const id = uid(req), user = await userOr404(id);
    if (String(req.body?.confirm || '').trim().toLowerCase() !== user.email.toLowerCase()) throw bad('Type the user\'s email to confirm.');
    await prisma.user.delete({ where: { id } });
    console.log(`[admin] ${req.admin.email} deleted user ${user.email} (#${id})`);
    res.json({ ok: true });
  }));

  /* ---------- Shortlisted candidates of every recruiter ---------- */
  const shortWhere = req => {
    const { user_id, q, role, min, from, to } = req.query, w = { shortlisted: true };
    if (Number.isInteger(Number(user_id)) && Number(user_id) > 0) w.user_id = Number(user_id);
    if (Number(min) > 0) w.score = { gte: Number(min) };
    if (q && String(q).trim()) w.OR = [{ name: { contains: String(q).trim(), mode: 'insensitive' } }, { file_name: { contains: String(q).trim(), mode: 'insensitive' } }];
    if (role && String(role).trim()) w.jd = { title: { contains: String(role).trim(), mode: 'insensitive' } };
    const rw = rangeWhere(from, to).created_at; if (rw) w.shortlisted_at = rw;
    return w;
  };
  r.get('/shortlisted', h(async (req, res) => {
    const rows = await prisma.candidate.findMany({ where: shortWhere(req), select: SHORT_SEL, orderBy: SHORT_ORDER, take: 500 });
    res.json(rows.map(slim));
  }));
  r.get('/shortlisted.csv', h(async (req, res) => {
    const rows = await prisma.candidate.findMany({ where: shortWhere(req), select: SHORT_SEL, orderBy: SHORT_ORDER, take: 5000 });
    const names = (a, st) => (a?.skills || []).filter(x => x.status === st).map(x => x.name).join('; ');
    const head = ['Shortlisted on', 'Candidate', 'File', 'Recruiter', 'Recruiter email', 'Job role', 'JD', 'Client', 'ATS %', 'Required hit', 'Required total', 'Required exp (yrs)', 'Candidate exp (yrs)', 'Exp missing (yrs)', 'Matched skills', 'Partial skills', 'Missing skills', 'Summary'];
    const lines = [head.map(csvCell).join(',')];
    for (const c of rows) {
      const e = candView(c).exp, a = c.analysis;
      lines.push([c.shortlisted_at ? fmtDT(c.shortlisted_at) : '', labelOf(c), c.file_name, c.user?.name, c.user?.email, c.jd?.title, pad('JD', c.jd_id), c.jd?.client, c.score, c.req_hit, c.req_total,
        e.required, e.candidate, e.missing, names(a, 'matched'), names(a, 'partial'), names(a, 'missing'), a?.summary].map(csvCell).join(','));
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="shortlisted-candidates.csv"' });
    res.send('\uFEFF' + lines.join('\r\n'));
  }));

  // Files / analysis of a SHORTLISTED candidate (admins can only open shortlisted profiles, never the rest of a recruiter's pool)
  const shortOr404 = async (req, extra = {}) => {
    const n = Number(req.params.id); if (!Number.isInteger(n)) throw bad('Invalid candidate.');
    const c = await prisma.candidate.findFirst({ where: { id: n, shortlisted: true }, select: { ...SHORT_SEL, ...extra } });
    if (!c) throw bad('Shortlisted candidate not found', 404);
    return c;
  };
  r.get('/candidates/:id', h(async (req, res) => res.json(candView(await shortOr404(req)))));
  r.get('/candidates/:id/resume', h(async (req, res) => {
    const c = await shortOr404(req, { file_type: true, file_data: true, resume_text: true });
    if (!c.file_data) {                                           // analysed before original files were stored -> fall back to the extracted text
      if (!c.resume_text) throw bad('No resume file stored for this candidate.', 404);
      res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeName(labelOf(c))}-resume.txt"` });
      return res.send(c.resume_text);
    }
    res.set({ 'Content-Type': MIME[c.file_type] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeName(c.file_name, 'resume')}"` });
    res.send(Buffer.from(c.file_data));
  }));
  r.get('/candidates/:id/jd', h(async (req, res) => {
    const c = await shortOr404(req);
    const jd = await prisma.jd.findUnique({ where: { id: c.jd_id }, select: { title: true, file_name: true, file_type: true, file_data: true, raw_text: true } });
    if (!jd) throw bad('JD not found', 404);
    if (jd.file_data) {
      res.set({ 'Content-Type': MIME[jd.file_type] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeName(jd.file_name, 'jd')}"` });
      return res.send(Buffer.from(jd.file_data));
    }
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeName(jd.title, 'jd')}.txt"` });
    res.send(jd.raw_text || '');
  }));
  r.get('/candidates/:id/analysis.pdf', h(async (req, res) => {
    const c = await shortOr404(req);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${safeName(labelOf(c))}-analysis.pdf"` });
    res.send(await buildAnalysisPdf(candView(c), c.jd?.title));
  }));
  r.get('/candidates/:id/masked.pdf', h(async (req, res) => {
    const c = await shortOr404(req, { masked_text: true });
    if (!c.masked_text) throw bad('This resume has not been masked yet.', 404);
    const s = await getSettings(c.user_id);
    const pdf = await buildPdf(c.masked_text, { code: labelOf(c), watermark: true, wmText: s.watermark_text, logo: s.logo_b64 ? { buf: Buffer.from(s.logo_b64, 'base64'), type: s.logo_type } : null });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${safeName(labelOf(c))}-masked.pdf"` });
    res.send(pdf);
  }));

  /* ---------- Admin saved searches (scopes a_short, a_log; stored per admin e-mail) ---------- */
  r.get('/searches', h(async (req, res) => {
    res.json(await prisma.savedSearch.findMany({ where: { admin_email: req.admin.email, scope: String(req.query.scope || '') }, select: { id: true, scope: true, name: true, query: true }, orderBy: { id: 'asc' } }));
  }));
  r.post('/searches', h(async (req, res) => {
    const scope = String(req.body.scope || ''), name = String(req.body.name || '').trim().slice(0, 60);
    if (!/^a_[a-z]{1,20}$/.test(scope)) throw bad('Invalid search scope.');
    if (!name) throw bad('Give the search a name.');
    const query = req.body.query && typeof req.body.query === 'object' && !Array.isArray(req.body.query) ? req.body.query : {};
    res.json(await prisma.savedSearch.create({ data: { admin_email: req.admin.email, scope, name, query }, select: { id: true, scope: true, name: true, query: true } }));
  }));
  r.delete('/searches/:id', h(async (req, res) => {
    await prisma.savedSearch.deleteMany({ where: { id: Number(req.params.id), admin_email: req.admin.email } });
    res.json({ ok: true });
  }));

  return r;
}
