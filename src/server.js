import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { prisma, getSettings } from './db.js';
import { fileToText } from './parse.js';
import { extractJD, analyzeResume, maskResume } from './ai.js';
import { score, requiredYears } from './match.js';
import { buildPdf } from './maskpdf.js';
import { readSession, startSession, endSession, requireAuth, verifyGmail, readAdminSession, startAdminSession, endAdminSession, requireAdminAuth } from './auth.js';
import { logActivity, logActivities, isAdminEmail, makeBuckets } from './activity.js';
import { pad, labelOf, candView, hasTerm, fileExt, MIME, safeName } from './shared.js';
import { buildAnalysisPdf } from './analysispdf.js';
import { adminRouter } from './admin.js';

const app = express();
app.set('trust proxy', 1);          // needed for secure cookies behind Render / Railway / Fly
app.use(compression());             // smaller responses = faster pages
app.use(express.json({ limit: '2mb' }));
const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const h = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  const status = e.status || (e.code === 'P2025' ? 404 : 500);          // P2025 = row not found (or not yours)
  res.status(status).json({ error: e.code === 'P2025' ? 'Not found' : e.message || 'Server error' });
});
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const appPage = fileURLToPath(new URL('../views/app.html', import.meta.url));
app.use(express.static(publicDir));                                                  // landing page + assets (public)
app.get('/app', (req, res) => readSession(req) ? res.sendFile(appPage) : res.redirect('/'));   // dashboard (login needed)

/* ---------------- Auth (Google, Gmail only) ---------------- */
app.get('/api/config', (req, res) => res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' }));
app.post('/api/auth/google', h(async (req, res) => {
  const g = await verifyGmail(req.body.credential);
  const user = await prisma.user.upsert({
    where: { google_id: g.google_id },
    update: { email: g.email, name: g.name, picture: g.picture, last_login: new Date() },
    create: g,
  });
  startSession(res, user.id);
  logActivity(user.id, 'login');
  res.json({ ok: true });
}));
app.post('/api/auth/logout', (req, res) => { endSession(res); res.json({ ok: true }); });

/* ---------------- Admin portal: completely separate from the HR app (own page, own sign-in, own cookie, own API) ---------------- */
const adminPage = fileURLToPath(new URL('../views/admin.html', import.meta.url));
const adminLogin = fileURLToPath(new URL('../views/admin-login.html', import.meta.url));
app.get('/admin', (req, res) => res.sendFile(readAdminSession(req) ? adminPage : adminLogin));
app.post('/admin-api/auth/google', h(async (req, res) => {
  const g = await verifyGmail(req.body.credential);
  if (!isAdminEmail(g.email)) throw Object.assign(new Error('This Google account is not an admin.'), { status: 403 });
  startAdminSession(res, g);
  res.json({ ok: true });
}));
app.post('/admin-api/auth/logout', (req, res) => { endAdminSession(res); res.json({ ok: true }); });
app.get('/admin-api/me', requireAdminAuth, (req, res) => res.json(req.admin));
app.use('/admin-api', requireAdminAuth, adminRouter(h, bad));

app.use('/api', requireAuth);        // everything below needs a signed-in HR
app.get('/api/me', h(async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, email: true, name: true, picture: true } });
  if (!u) { endSession(res); throw bad('Please sign in.', 401); }
  res.json(u);
}));

/* ---------- helpers ---------- */
const sel = keys => Object.fromEntries(keys.map(k => [k, true]));
const jdOut = r => r && ({ ...r, code: pad('JD', r.id), cand_count: r._count?.candidates, _count: undefined });
// Candidates are shown everywhere by FIRST NAME only (never the surname). No name found -> CAND-001 style code.
const cOut = r => r && ({ ...r, code: pad('CAND', r.id), label: labelOf(r) });
const id = req => Number(req.params.id);
const mine = req => ({ user_id: req.user.id });   // every query is limited to the signed-in HR's own rows

const JD_FIELDS = ['title', 'client', 'total_exp', 'relevant_exp', 'location', 'work_mode', 'employment_type', 'budget', 'current_ctc', 'expected_ctc', 'seniority',
  'required_skills', 'preferred_skills', 'hands_on', 'responsibilities', 'technologies', 'education', 'certifications'];
const LISTS = new Set(['required_skills', 'preferred_skills', 'hands_on', 'responsibilities', 'technologies', 'education', 'certifications']);
const NUMS = new Set(['total_exp', 'relevant_exp']);
const norm = (k, v) => LISTS.has(k) ? (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [])
  : NUMS.has(k) ? (v === '' || v == null || !isFinite(+v) ? null : +v)
  : (v == null ? null : String(v).trim() || null);
const jdData = o => Object.fromEntries(JD_FIELDS.map(k => [k, norm(k, o[k])]));

const JD_SEL = sel(['id', ...JD_FIELDS, 'status', 'created_at']);       // everything except raw_text
const CAND_SEL = sel(['id', 'file_name', 'jd_id', 'name', 'analysis', 'score', 'req_hit', 'req_total', 'shortlisted', 'shortlisted_at', 'mask_status', 'mask_error', 'created_at']);

/* ---------------- JDs ---------------- */
app.get('/api/jds', h(async (req, res) => {
  const rows = await prisma.jd.findMany({ where: mine(req), select: { ...JD_SEL, _count: { select: { candidates: true } } }, orderBy: { id: 'desc' } });
  res.json(rows.map(jdOut));
}));
app.get('/api/jds/:id', h(async (req, res) => {
  const jd = await prisma.jd.findFirst({ where: { id: id(req), ...mine(req) }, select: JD_SEL });
  if (!jd) throw bad('JD not found', 404);
  res.json(jdOut(jd));
}));

app.get('/api/jds/:id/file', h(async (req, res) => {              // the JD as it was uploaded (or the pasted text)
  const jd = await prisma.jd.findFirst({ where: { id: id(req), ...mine(req) }, select: { title: true, file_name: true, file_type: true, file_data: true, raw_text: true } });
  if (!jd) throw bad('JD not found', 404);
  if (jd.file_data) {
    res.set({ 'Content-Type': MIME[jd.file_type] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeName(jd.file_name, 'jd')}"` });
    return res.send(Buffer.from(jd.file_data));
  }
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeName(jd.title, 'jd')}.txt"` });
  res.send(jd.raw_text || '');
}));
// Upload (or paste) a JD -> AI fills every field -> returned as a draft for review / manual completion.
app.post('/api/jds/extract', up.single('file'), h(async (req, res) => {
  const text = req.file ? await fileToText(req.file) : String(req.body.text || '').trim();
  if (text.length < 40) throw bad('Provide a JD file or paste at least a few lines of text.');
  const d = await extractJD(text);
  const jd = await prisma.jd.create({ data: { ...jdData(d), raw_text: text, status: 'draft', user_id: req.user.id, ...(req.file ? { file_name: req.file.originalname, file_type: fileExt(req.file.originalname), file_data: req.file.buffer } : {}) }, select: JD_SEL });
  logActivity(req.user.id, 'jd_extracted', { entity: 'jd', entityId: jd.id, label: pad('JD', jd.id), detail: { title: jd.title, file: req.file?.originalname || 'pasted text' } });
  res.json(jdOut(jd));
}));
app.put('/api/jds/:id', h(async (req, res) => {
  const jd = await prisma.jd.update({ where: { id: id(req), ...mine(req) }, data: { ...jdData(req.body), status: 'saved' }, select: JD_SEL });
  logActivity(req.user.id, 'jd_saved', { entity: 'jd', entityId: jd.id, label: pad('JD', jd.id), detail: { title: jd.title } });
  res.json(jdOut(jd));
}));
app.delete('/api/jds/:id', h(async (req, res) => {
  const jd = await prisma.jd.findFirst({ where: { id: id(req), ...mine(req) }, select: { id: true, title: true, _count: { select: { candidates: true } } } });
  const r = await prisma.jd.deleteMany({ where: { id: id(req), ...mine(req) } });
  if (r.count && jd) logActivity(req.user.id, 'jd_deleted', { entity: 'jd', entityId: jd.id, label: pad('JD', jd.id), detail: { title: jd.title, resumes_removed: jd._count.candidates } });
  res.json({ ok: true });
}));

/* ---------------- Candidates ---------------- */
const matched = c => (c.analysis?.skills || []).filter(s => s.status === 'matched').length;
const rank = (a, b) => b.score - a.score || b.req_hit - a.req_hit || matched(b) - matched(a);

app.get('/api/candidates', h(async (req, res) => {
  const rows = await prisma.candidate.findMany({ where: { ...mine(req), ...(req.query.jdId ? { jd_id: Number(req.query.jdId) } : {}) }, select: CAND_SEL });
  res.json(rows.map(cOut).sort(rank));
}));

// One resume per request (the client loops) -> no long-running requests.
app.post('/api/candidates', up.single('file'), h(async (req, res) => {
  const jd = await prisma.jd.findFirst({ where: { id: Number(req.body.jdId), ...mine(req) } });
  if (!jd) throw bad('Select or save a JD first.');
  if (!req.file) throw bad('No file uploaded.');
  let row;
  try {
    const [settings, text] = await Promise.all([getSettings(req.user.id), fileToText(req.file)]);
    const analysis = await analyzeResume(jd, text);
    analysis.required_years = requiredYears(jd, settings.min_exp);
    const sc = score(analysis, analysis.required_years);
    row = await prisma.candidate.create({
      data: { file_name: req.file.originalname, resume_text: text, jd_id: jd.id, user_id: req.user.id, name: analysis.candidate || null, analysis, score: sc.score, req_hit: sc.req_hit, req_total: sc.req_total,
        file_type: fileExt(req.file.originalname), file_data: req.file.buffer },
      select: CAND_SEL,
    });
  } catch (e) {
    logActivity(req.user.id, 'resume_failed', { entity: 'jd', entityId: jd.id, label: pad('JD', jd.id), detail: { file: req.file.originalname, jd_title: jd.title, error: String(e.message || e).slice(0, 300) } });
    throw e;
  }
  logActivity(req.user.id, 'resume_analyzed', { entity: 'candidate', entityId: row.id, label: labelOf(row), detail: { file: row.file_name, jd_id: jd.id, jd_title: jd.title, jd_code: pad('JD', jd.id), score: row.score, req_hit: row.req_hit, req_total: row.req_total } });
  res.json(cOut(row));
}));
app.patch('/api/candidates/:id', h(async (req, res) => {
  const row = await prisma.candidate.update({ where: { id: id(req), ...mine(req) }, data: { shortlisted: !!req.body.shortlisted, shortlisted_at: req.body.shortlisted ? new Date() : null }, select: CAND_SEL });
  logActivity(req.user.id, row.shortlisted ? 'shortlisted' : 'unshortlisted', { entity: 'candidate', entityId: row.id, label: labelOf(row), detail: { file: row.file_name, jd_id: row.jd_id } });
  res.json(cOut(row));
}));
const delInfo = c => ({ entity: 'candidate', entityId: c.id, label: labelOf(c), detail: { file: c.file_name, jd_id: c.jd_id } });
app.delete('/api/candidates/:id', h(async (req, res) => {
  const c = await prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { id: true, name: true, file_name: true, jd_id: true } });
  const r = await prisma.candidate.deleteMany({ where: { id: id(req), ...mine(req) } });
  if (r.count && c) logActivity(req.user.id, 'candidate_deleted', delInfo(c));
  res.json({ ok: true });
}));
// Delete many candidates at once (Processed Resumes -> select all -> Delete selected)
app.post('/api/candidates/bulk-delete', h(async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) throw bad('No candidates selected.');
  const gone = await prisma.candidate.findMany({ where: { id: { in: ids }, ...mine(req) }, select: { id: true, name: true, file_name: true, jd_id: true } });
  const r = await prisma.candidate.deleteMany({ where: { id: { in: ids }, ...mine(req) } });
  if (r.count) logActivities(req.user.id, 'candidate_deleted', gone.map(c => ({ ...delInfo(c), detail: { ...delInfo(c).detail, bulk: true } })));
  res.json({ ok: true, deleted: r.count });
}));


/* ---------------- Single candidate, files, re-match ---------------- */
app.get('/api/candidates/:id', h(async (req, res) => {
  const c = await prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { ...CAND_SEL, jd: { select: { id: true, title: true, client: true } } } });
  if (!c) throw bad('Candidate not found', 404);
  res.json(candView(c));
}));
app.get('/api/candidates/:id/analysis.pdf', h(async (req, res) => {
  const c = await prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { ...CAND_SEL, jd: { select: { title: true } } } });
  if (!c) throw bad('Candidate not found', 404);
  const pdf = await buildAnalysisPdf(cOut(c), c.jd?.title);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${safeName(labelOf(c), pad('CAND', c.id))}-analysis.pdf"` });
  res.send(pdf);
}));
app.get('/api/candidates/:id/file', h(async (req, res) => {          // the resume exactly as it was uploaded
  const c = await prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { file_name: true, file_type: true, file_data: true } });
  if (!c) throw bad('Candidate not found', 404);
  if (!c.file_data) throw bad('The original file was not stored for this resume (it was analyzed before file storage was added).', 404);
  res.set({ 'Content-Type': MIME[c.file_type] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeName(c.file_name, 'resume')}"` });
  res.send(Buffer.from(c.file_data));
}));
// Score an already-stored resume against another saved JD without uploading it again.
app.post('/api/candidates/:id/rematch', h(async (req, res) => {
  const [src, jd, settings] = await Promise.all([
    prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { id: true, name: true, file_name: true, resume_text: true, file_type: true, file_data: true } }),
    prisma.jd.findFirst({ where: { id: Number(req.body.jdId), ...mine(req) } }),
    getSettings(req.user.id),
  ]);
  if (!src) throw bad('Candidate not found', 404);
  if (!jd) throw bad('Select a saved JD.');
  if (!src.resume_text) throw bad('This resume has no stored text to re-match.');
  const dup = await prisma.candidate.findFirst({ where: { ...mine(req), jd_id: jd.id, file_name: src.file_name, ...(src.name ? { name: src.name } : {}) }, select: CAND_SEL });
  if (dup) return res.json({ ...cOut(dup), existing: true });
  const analysis = await analyzeResume(jd, src.resume_text);
  analysis.required_years = requiredYears(jd, settings.min_exp);
  const sc = score(analysis, analysis.required_years);
  const row = await prisma.candidate.create({
    data: { file_name: src.file_name, resume_text: src.resume_text, jd_id: jd.id, user_id: req.user.id, name: analysis.candidate || src.name, analysis, score: sc.score, req_hit: sc.req_hit, req_total: sc.req_total, file_type: src.file_type, file_data: src.file_data ?? undefined },
    select: CAND_SEL,
  });
  logActivity(req.user.id, 'resume_analyzed', { entity: 'candidate', entityId: row.id, label: labelOf(row), detail: { file: row.file_name, jd_id: jd.id, jd_title: jd.title, jd_code: pad('JD', jd.id), score: row.score, req_hit: row.req_hit, req_total: row.req_total, rematch: true } });
  res.json({ ...cOut(row), existing: false });
}));

/* ---------------- Talent search (every resume ever analyzed, any JD) ---------------- */
app.get('/api/talent', h(async (req, res) => {
  const { q = '', skills = '', mode = 'any', role = '', min = '', short = '' } = req.query;
  const terms = String(skills).split(/[\n,;]+/).map(x => x.trim()).filter(Boolean).slice(0, 30);
  const rows = await prisma.candidate.findMany({
    where: { ...mine(req), ...(short === '1' ? { shortlisted: true } : {}), ...(Number(min) > 0 ? { score: { gte: Number(min) } } : {}) },
    select: { id: true, name: true, file_name: true, score: true, shortlisted: true, jd_id: true, analysis: true, resume_text: true, jd: { select: { title: true } } },
    orderBy: { id: 'desc' }, take: 3000,
  });
  const groups = new Map();                                   // same person analysed for several JDs -> one row
  for (const c of rows) {
    const key = (c.name || '').trim().toLowerCase() || (c.file_name || '').toLowerCase() || String(c.id);
    (groups.get(key) || groups.set(key, []).get(key)).push(c);
  }
  const qq = String(q).trim().toLowerCase(), rr = String(role).trim().toLowerCase(), out = [];
  for (const list of groups.values()) {
    const best = list.reduce((a, b) => ((b.score ?? -1) > (a.score ?? -1) ? b : a));
    const roles = [...new Set(list.map(c => c.jd?.title || pad('JD', c.jd_id)))];
    const label = labelOf(best);
    if (qq && ![best.name, label, best.file_name].some(v => String(v || '').toLowerCase().includes(qq))) continue;
    if (rr && !roles.some(t => t.toLowerCase().includes(rr))) continue;
    const found = terms.filter(t => list.some(c => hasTerm(c.resume_text, t) || (c.analysis?.skills || []).some(s => s.status === 'matched' && hasTerm(s.name, t))));
    if (terms.length && (mode === 'all' ? found.length < terms.length : !found.length)) continue;
    out.push({ id: best.id, name: best.name, label, file_name: best.file_name, shortlisted: list.some(c => c.shortlisted), score: best.score ?? 0, roles, hits: found.length, found });
  }
  out.sort((a, b) => b.hits - a.hits || b.score - a.score);
  res.json(out.slice(0, 200));
}));

/* ---------------- Dashboard tracker: JDs vs analyzed vs shortlisted ---------------- */
app.get('/api/tracker', h(async (req, res) => {
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'week';
  const { list, keyOf, since } = makeBuckets(period, period === 'day' ? 14 : 12);
  const buckets = list.map(b => ({ ...b, jds: 0, analyzed: 0, shortlisted: 0 })), by = new Map(buckets.map(b => [b.key, b]));
  const bump = (d, f) => { const b = by.get(keyOf(d)); if (b) b[f]++; };
  const [jdRows, candRows, shortRows, jdList, perJd] = await Promise.all([
    prisma.jd.findMany({ where: { ...mine(req), created_at: { gte: since } }, select: { created_at: true } }),
    prisma.candidate.findMany({ where: { ...mine(req), created_at: { gte: since } }, select: { created_at: true } }),
    prisma.candidate.findMany({ where: { ...mine(req), shortlisted: true }, select: { id: true, name: true, score: true, jd_id: true, shortlisted_at: true, created_at: true, jd: { select: { title: true } } }, orderBy: [{ shortlisted_at: 'desc' }, { id: 'desc' }] }),
    prisma.jd.findMany({ where: mine(req), select: { id: true, title: true } }),
    prisma.candidate.groupBy({ by: ['jd_id', 'shortlisted'], where: mine(req), _count: { _all: true } }),
  ]);
  jdRows.forEach(r => bump(r.created_at, 'jds'));
  candRows.forEach(r => bump(r.created_at, 'analyzed'));
  shortRows.forEach(r => { const d = r.shortlisted_at || r.created_at; if (d >= since) bump(d, 'shortlisted'); });
  const roles = jdList.map(j => {
    const rows = perJd.filter(g => g.jd_id === j.id);
    return { id: j.id, title: j.title, code: pad('JD', j.id), analyzed: rows.reduce((n, g) => n + g._count._all, 0), shortlisted: rows.filter(g => g.shortlisted).reduce((n, g) => n + g._count._all, 0) };
  }).sort((a, b) => b.shortlisted - a.shortlisted || b.analyzed - a.analyzed);
  const shortlisted = shortRows.map(r => ({ id: r.id, label: labelOf(r), name: r.name, score: r.score, job_role: r.jd?.title || null, jd_code: pad('JD', r.jd_id), shortlisted_at: r.shortlisted_at, created_at: r.created_at }));
  res.json({ period, buckets, roles, shortlisted });
}));

/* ---------------- Saved searches (named filter sets per panel) ---------------- */
app.get('/api/searches', h(async (req, res) => {
  res.json(await prisma.savedSearch.findMany({ where: { ...mine(req), scope: String(req.query.scope || '') }, select: { id: true, scope: true, name: true, query: true }, orderBy: { id: 'asc' } }));
}));
app.post('/api/searches', h(async (req, res) => {
  const scope = String(req.body.scope || ''), name = String(req.body.name || '').trim().slice(0, 60);
  if (!/^[a-z]{1,24}$/.test(scope)) throw bad('Invalid search scope.');
  if (!name) throw bad('Give the search a name.');
  const query = req.body.query && typeof req.body.query === 'object' && !Array.isArray(req.body.query) ? req.body.query : {};
  res.json(await prisma.savedSearch.create({ data: { user_id: req.user.id, scope, name, query }, select: { id: true, scope: true, name: true, query: true } }));
}));
app.delete('/api/searches/:id', h(async (req, res) => {
  await prisma.savedSearch.deleteMany({ where: { id: id(req), ...mine(req) } });
  res.json({ ok: true });
}));

/* ---------------- Masking ---------------- */
app.post('/api/candidates/:id/mask', h(async (req, res) => {
  const [c, s] = await Promise.all([
    prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { id: true, name: true, resume_text: true } }),
    getSettings(req.user.id),
  ]);
  if (!c) throw bad('Candidate not found', 404);
  let data;
  try {
    const masked = await maskResume(c.resume_text, labelOf(c), s.hide || {});
    if (masked.length < 50) throw new Error('empty result');
    data = { masked_text: masked, mask_status: 'masked', mask_error: null };
  } catch (e) { data = { mask_status: 'failed', mask_error: e.message }; }
  const out = await prisma.candidate.update({ where: { id: c.id }, data, select: CAND_SEL });
  logActivity(req.user.id, data.mask_status === 'masked' ? 'resume_masked' : 'mask_failed', { entity: 'candidate', entityId: c.id, label: labelOf(c), detail: { file: out.file_name, jd_id: out.jd_id, ...(data.mask_error ? { error: String(data.mask_error).slice(0, 300) } : {}) } });
  res.json(cOut(out));
}));
app.get('/api/candidates/:id/masked', h(async (req, res) => {
  const c = await prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { id: true, name: true, masked_text: true, resume_text: true, mask_status: true } });
  if (!c) throw bad('Candidate not found', 404);
  res.json({ code: labelOf(c), text: c.masked_text, original: c.resume_text || '', status: c.mask_status });
}));
app.put('/api/candidates/:id/masked', h(async (req, res) => {   // manual clean-up edits
  const c = await prisma.candidate.update({ where: { id: id(req), ...mine(req) }, data: { masked_text: String(req.body.text || ''), mask_status: 'masked' }, select: { id: true, name: true, file_name: true, jd_id: true } });
  logActivity(req.user.id, 'mask_edited', { entity: 'candidate', entityId: c.id, label: labelOf(c), detail: { file: c.file_name, jd_id: c.jd_id } });
  res.json({ ok: true });
}));
app.get('/api/candidates/:id/masked.pdf', h(async (req, res) => {
  const [c, s] = await Promise.all([
    prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { id: true, name: true, file_name: true, jd_id: true, masked_text: true } }),
    getSettings(req.user.id),
  ]);
  if (!c?.masked_text) throw bad('Resume has not been masked yet.', 404);
  const wm = req.query.wm !== '0', code = labelOf(c);
  const pdf = await buildPdf(c.masked_text, {
    code, watermark: wm, wmText: s.watermark_text,
    logo: s.logo_b64 ? { buf: Buffer.from(s.logo_b64, 'base64'), type: s.logo_type } : null,
  });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${code.replace(/[^\w-]+/g, '') || pad('CAND', c.id)}${wm ? '-watermarked' : ''}.pdf"` });
  if (req.query.download) logActivity(req.user.id, 'pdf_downloaded', { entity: 'candidate', entityId: c.id, label: code, detail: { file: c.file_name, jd_id: c.jd_id, watermark: wm } });
  res.send(pdf);
}));

/* ---------------- Settings / stats ---------------- */
app.get('/api/settings', h(async (req, res) => {
  const s = await getSettings(req.user.id);
  res.json({ hide: s.hide, watermark_text: s.watermark_text, min_exp: s.min_exp, has_logo: !!s.logo_b64 });
}));
app.put('/api/settings', h(async (req, res) => {
  const { hide, watermark_text, min_exp } = req.body;
  const data = { hide: hide || {}, watermark_text: watermark_text || '', min_exp: Number(min_exp) || 0 };
  await prisma.setting.upsert({ where: { user_id: req.user.id }, update: data, create: { user_id: req.user.id, ...data } });
  logActivity(req.user.id, 'settings_updated');
  res.json({ ok: true });
}));
app.post('/api/settings/logo', up.single('file'), h(async (req, res) => {
  const f = req.file;
  if (!f || !['image/png', 'image/jpeg'].includes(f.mimetype) || f.size > 1048576) throw bad('Logo must be PNG or JPEG, max 1 MB.');
  await getSettings(req.user.id);
  await prisma.setting.update({ where: { user_id: req.user.id }, data: { logo_b64: f.buffer.toString('base64'), logo_type: f.mimetype } });
  logActivity(req.user.id, 'logo_changed', { detail: { change: 'uploaded' } });
  res.json({ ok: true });
}));
app.get('/api/settings/logo', h(async (req, res) => {
  const s = await getSettings(req.user.id);
  if (!s.logo_b64) return res.status(404).end();
  res.type(s.logo_type).send(Buffer.from(s.logo_b64, 'base64'));
}));
app.delete('/api/settings/logo', h(async (req, res) => {
  await getSettings(req.user.id);
  await prisma.setting.update({ where: { user_id: req.user.id }, data: { logo_b64: null, logo_type: null } });
  logActivity(req.user.id, 'logo_changed', { detail: { change: 'removed' } });
  res.json({ ok: true });
}));

app.get('/api/stats', h(async (req, res) => {
  const [resumes, jds, masked, mask_failed, shortlisted, rc, rj] = await Promise.all([
    prisma.candidate.count({ where: mine(req) }), prisma.jd.count({ where: mine(req) }),
    prisma.candidate.count({ where: { ...mine(req), mask_status: 'masked' } }), prisma.candidate.count({ where: { ...mine(req), mask_status: 'failed' } }),
    prisma.candidate.count({ where: { ...mine(req), shortlisted: true } }),
    prisma.candidate.findMany({ where: mine(req), select: sel(['id', 'name', 'score', 'mask_status', 'created_at']), orderBy: { id: 'desc' }, take: 5 }),
    prisma.jd.findMany({ where: mine(req), select: sel(['id', 'title', 'employment_type', 'location', 'created_at']), orderBy: { id: 'desc' }, take: 5 }),
  ]);
  res.json({ resumes, jds, masked, mask_failed, shortlisted, recent_candidates: rc.map(cOut), recent_jds: rj.map(jdOut) });
}));
// NOTE: the self-service "Delete all data" endpoint was removed. Complete deletion is now an Admin Panel action (src/admin.js).

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`CandidateMatch AI running on http://localhost:${port}`));

// Pre-load the PDF / DOCX parsers and open the DB connection so the FIRST upload after a (re)start is not slow.
import('pdf-parse/lib/pdf-parse.js').catch(() => {});
import('mammoth').catch(() => {});
prisma.$queryRaw`SELECT 1`.catch(() => {});

// Optional (set KEEP_WARM=1 on Render): pings the app + database every 10 min so a free instance / Neon does not fall asleep.
if (process.env.KEEP_WARM === '1') {
  const self = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  setInterval(() => {
    if (self) fetch(self.replace(/\/$/, '') + '/api/config').catch(() => {});
    prisma.$queryRaw`SELECT 1`.catch(() => {});
  }, 10 * 60 * 1000).unref();
}
