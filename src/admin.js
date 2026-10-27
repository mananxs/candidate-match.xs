// Admin portal API (mounted at /admin-api behind requireAdminAuth). Only emails listed in ADMIN_EMAILS can sign in.
// Admins see activity METADATA (who did what, when, file names, scores). The only resume content they can open is that of
// SHORTLISTED candidates (Shortlisted page: original resume, JD file, analysis, masked PDF) - never resumes that were not shortlisted.
import express from 'express';
import { prisma, getSettings } from './db.js';
import { ACTIONS, emptyCounts, addCount, buildReport, rangeWhere, isDate, logActivity, TIMEZONE } from './activity.js';
import { pad, labelOf, analysisPdf, sendStored, csvCell, experienceGap } from './report.js';
import { buildPdf } from './maskpdf.js';
import { searchRouter } from './searches.js';

const USER_PUB = { id: true, name: true, email: true, picture: true, created_at: true, last_login: true };
const fmtDT = d => new Date(d).toLocaleString('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

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

  /* ---------- Shortlisted candidates of every user (with job role, JD, resume and analysis) ---------- */
  const SHORT_SEL = {
    id: true, name: true, file_name: true, score: true, req_hit: true, req_total: true, analysis: true, shortlisted: true, shortlisted_at: true, created_at: true, mask_status: true, jd_id: true,
    jd: { select: { id: true, title: true, client: true, file_name: true, total_exp: true, relevant_exp: true } },
    user: { select: { id: true, name: true, email: true, picture: true } },
  };
  const shortWhere = q => {
    const s = String(q.q || '').trim(), role = String(q.role || '').trim();
    const w = { shortlisted: true, ...(Number(q.user_id) ? { user_id: Number(q.user_id) } : {}), ...(Number(q.min) ? { score: { gte: Number(q.min) } } : {}) };
    if (role) w.jd = { title: { contains: role, mode: 'insensitive' } };
    if (s) w.OR = [{ name: { contains: s, mode: 'insensitive' } }, { file_name: { contains: s, mode: 'insensitive' } }];
    const rg = rangeWhere(q.from, q.to).created_at;
    if (rg) w.AND = [{ OR: [{ shortlisted_at: rg }, { shortlisted_at: null, created_at: rg }] }];
    return w;
  };
  const shortOut = c => ({ ...c, label: labelOf(c), code: pad('CAND', c.id), jd_code: pad('JD', c.jd_id), job_role: c.jd?.title || null, exp: experienceGap(c.analysis) });
  const shortList = (q, take) => prisma.candidate.findMany({ where: shortWhere(q), select: SHORT_SEL, orderBy: [{ shortlisted_at: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }], take });

  r.get('/shortlisted', h(async (req, res) => res.json((await shortList(req.query, 1000)).map(shortOut))));
  r.get('/shortlisted.csv', h(async (req, res) => {
    const rows = (await shortList(req.query, 20000)).map(shortOut);
    const sk = (c, f) => (c.analysis?.skills || []).filter(f).map(s => s.name + (s.hands_on ? (s.status === 'missing' ? ' [hands-on req.]' : s.hands_on_shown ? ' [hands-on]' : ' [hands-on not shown]') : '')).join('; ');
    const lines = [['Shortlisted on', 'Recruiter', 'Recruiter email', 'Candidate', 'Resume file', 'Job role', 'JD', 'Client', 'ATS %', 'Required covered', 'Required exp (yrs)', 'Candidate exp (yrs)', 'Missing exp (yrs)', 'Matched skills', 'Preferred matched', 'Missing skills', 'Summary'].map(csvCell).join(',')];
    for (const c of rows) lines.push([fmtDT(c.shortlisted_at || c.created_at), c.user?.name || '', c.user?.email || '', c.name || c.label, c.file_name, c.job_role || '', c.jd_code, c.jd?.client || '', c.score, `${c.req_hit}/${c.req_total}`,
      c.exp.required ?? '', c.exp.candidate ?? '', c.exp.missing || '', sk(c, s => s.type !== 'preferred' && s.status !== 'missing'), sk(c, s => s.type === 'preferred' && s.status !== 'missing'), sk(c, s => s.status === 'missing'), c.analysis?.summary || ''].map(csvCell).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="shortlisted-candidates.csv"' });
    res.send('\uFEFF' + lines.join('\r\n'));
  }));
  // Files of ONE shortlisted candidate. Anything not shortlisted is 404 for admins.
  const shortOne = async (req, extra = {}) => {
    const c = await prisma.candidate.findFirst({ where: { id: Number(req.params.id) || 0, shortlisted: true }, select: { ...SHORT_SEL, ...extra } });
    if (!c) throw bad('Shortlisted candidate not found', 404);
    return c;
  };
  r.get('/candidates/:id', h(async (req, res) => res.json(shortOut(await shortOne(req)))));
  r.get('/candidates/:id/resume', h(async (req, res) => {
    const c = await shortOne(req, { file_type: true, file_data: true, resume_text: true });
    sendStored(res, { name: c.file_name, type: c.file_type, data: c.file_data, text: c.resume_text });
  }));
  r.get('/candidates/:id/jd', h(async (req, res) => {
    const c = await shortOne(req);
    const jd = await prisma.jd.findUnique({ where: { id: c.jd_id }, select: { id: true, title: true, file_name: true, file_type: true, file_data: true, raw_text: true } });
    if (!jd) throw bad('JD not found', 404);
    sendStored(res, { name: jd.file_name || `${pad('JD', jd.id)} ${jd.title || ''}`.trim(), type: jd.file_type, data: jd.file_data, text: jd.raw_text });
  }));
  r.get('/candidates/:id/analysis.pdf', h(async (req, res) => {
    const c = await shortOne(req);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${labelOf(c).replace(/[^\w-]+/g, '')}-${pad('JD', c.jd_id)}-analysis.pdf"` });
    res.send(await analysisPdf(c, c.jd, c.user ? `${c.user.name || ''} <${c.user.email}>` : ''));
  }));
  r.get('/candidates/:id/masked.pdf', h(async (req, res) => {
    const c = await shortOne(req, { masked_text: true, user_id: true });
    if (!c.masked_text) throw bad('This resume has not been masked yet.', 404);
    const s = await getSettings(c.user_id);
    const pdf = await buildPdf(c.masked_text, { code: labelOf(c), watermark: true, wmText: s.watermark_text, logo: s.logo_b64 ? { buf: Buffer.from(s.logo_b64, 'base64'), type: s.logo_type } : null });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${labelOf(c).replace(/[^\w-]+/g, '')}-masked.pdf"` });
    res.send(pdf);
  }));

  r.use('/searches', searchRouter(h, bad, req => ({ admin_email: req.admin.email })));

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
      shortList({}, 8),
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
      shortlisted: shortRecent.map(c => ({ ...shortOut(c), analysis: undefined })),
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
      shortList({ user_id: id }, 200),
    ]);
    const counts = emptyCounts(); groups.forEach(g => addCount(counts, g.action, g._count._all));
    res.json({ user, counts, stored: { jds, resumes, masked, shortlisted }, shortlisted: shortRows.map(c => ({ ...shortOut(c), analysis: undefined })), tz: TIMEZONE, actions: ACTIONS });
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
    const cell = csvCell;
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

  return r;
}
