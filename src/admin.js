// Admin portal API (mounted at /admin-api behind requireAdminAuth). Only emails listed in ADMIN_EMAILS can sign in.
// Admins see activity METADATA only (who did what, when, file names, scores) - never resume text or masked text.
import express from 'express';
import { prisma } from './db.js';
import { ACTIONS, emptyCounts, addCount, buildReport, rangeWhere, isDate, logActivity, TIMEZONE } from './activity.js';

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

  /* Dashboard: headline numbers + every user with their totals */
  r.get('/overview', h(async (req, res) => {
    const now = Date.now(), d7 = new Date(now - 7 * 864e5), d30 = new Date(now - 30 * 864e5);
    const [users, groups, a7, a30, active7] = await Promise.all([
      prisma.user.findMany({ select: USER_PUB, orderBy: { last_login: 'desc' } }),
      prisma.activityLog.groupBy({ by: ['user_id', 'action'], _count: { _all: true }, _max: { created_at: true } }),
      prisma.activityLog.count({ where: { created_at: { gte: d7 } } }),
      prisma.activityLog.count({ where: { created_at: { gte: d30 } } }),
      prisma.activityLog.groupBy({ by: ['user_id'], where: { created_at: { gte: d7 } } }),
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
      totals: { users: users.length, active_7d: active7.length, actions_7d: a7, actions_30d: a30 },
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
    const [groups, jds, resumes, masked, shortlisted] = await Promise.all([
      prisma.activityLog.groupBy({ by: ['action'], where: { user_id: id }, _count: { _all: true } }),
      prisma.jd.count({ where: { user_id: id } }), prisma.candidate.count({ where: { user_id: id } }),
      prisma.candidate.count({ where: { user_id: id, mask_status: 'masked' } }), prisma.candidate.count({ where: { user_id: id, shortlisted: true } }),
    ]);
    const counts = emptyCounts(); groups.forEach(g => addCount(counts, g.action, g._count._all));
    res.json({ user, counts, stored: { jds, resumes, masked, shortlisted }, tz: TIMEZONE, actions: ACTIONS });
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

  return r;
}
