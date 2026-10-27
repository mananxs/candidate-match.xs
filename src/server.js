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
import { logActivity, logActivities, isAdminEmail, periodList, periodKey, TIMEZONE } from './activity.js';
import { pad, labelOf, analysisPdf, sendStored } from './report.js';
import { searchRouter } from './searches.js';
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
// Candidates are shown everywhere by FIRST NAME only (never the surname). No name found -> CAND-001 style code (labelOf in report.js).
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

const JD_SEL = sel(['id', ...JD_FIELDS, 'status', 'created_at', 'file_name']);       // everything except raw_text / file bytes
const CAND_SEL = sel(['id', 'file_name', 'jd_id', 'name', 'analysis', 'score', 'req_hit', 'req_total', 'shortlisted', 'shortlisted_at', 'mask_status', 'mask_error', 'created_at']);
const MATCH_JD = sel(['id', 'title', 'required_skills', 'preferred_skills', 'technologies', 'hands_on', 'relevant_exp', 'total_exp']);   // what analysis needs

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

// Upload (or paste) a JD -> AI fills every field -> returned as a draft for review / manual completion.
app.post('/api/jds/extract', up.single('file'), h(async (req, res) => {
  const text = req.file ? await fileToText(req.file) : String(req.body.text || '').trim();
  if (text.length < 40) throw bad('Provide a JD file or paste at least a few lines of text.');
  const d = await extractJD(text);
  const file = req.file ? { file_name: req.file.originalname, file_type: req.file.mimetype, file_data: req.file.buffer } : {};
  const jd = await prisma.jd.create({ data: { ...jdData(d), ...file, raw_text: text, status: 'draft', user_id: req.user.id }, select: JD_SEL });
  logActivity(req.user.id, 'jd_extracted', { entity: 'jd', entityId: jd.id, label: pad('JD', jd.id), detail: { title: jd.title, file: req.file?.originalname || 'pasted text' } });
  res.json(jdOut(jd));
}));
app.put('/api/jds/:id', h(async (req, res) => {
  const jd = await prisma.jd.update({ where: { id: id(req), ...mine(req) }, data: { ...jdData(req.body), status: 'saved' }, select: JD_SEL });
  logActivity(req.user.id, 'jd_saved', { entity: 'jd', entityId: jd.id, label: pad('JD', jd.id), detail: { title: jd.title } });
  res.json(jdOut(jd));
}));
app.get('/api/jds/:id/file', h(async (req, res) => {        // original JD file (or its text when it was pasted)
  const jd = await prisma.jd.findFirst({ where: { id: id(req), ...mine(req) }, select: { id: true, title: true, file_name: true, file_type: true, file_data: true, raw_text: true } });
  if (!jd) throw bad('JD not found', 404);
  sendStored(res, { name: jd.file_name || `${pad('JD', jd.id)} ${jd.title || ''}`.trim(), type: jd.file_type, data: jd.file_data, text: jd.raw_text });
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
  const jd = await prisma.jd.findFirst({ where: { id: Number(req.body.jdId), ...mine(req) }, select: MATCH_JD });
  if (!jd) throw bad('Select or save a JD first.');
  if (!req.file) throw bad('No file uploaded.');
  let row;
  try {
    const [settings, text] = await Promise.all([getSettings(req.user.id), fileToText(req.file)]);
    const analysis = await analyzeResume(jd, text);
    analysis.required_years = requiredYears(jd, settings.min_exp);
    const sc = score(analysis, analysis.required_years);
    row = await prisma.candidate.create({
      data: { file_name: req.file.originalname, file_type: req.file.mimetype, file_data: req.file.buffer, resume_text: text, jd_id: jd.id, user_id: req.user.id, name: analysis.candidate || null, analysis, score: sc.score, req_hit: sc.req_hit, req_total: sc.req_total },
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
  const on = !!req.body.shortlisted;
  const row = await prisma.candidate.update({ where: { id: id(req), ...mine(req) }, data: { shortlisted: on, shortlisted_at: on ? new Date() : null }, select: { ...CAND_SEL, jd: { select: { title: true } } } });
  logActivity(req.user.id, row.shortlisted ? 'shortlisted' : 'unshortlisted', { entity: 'candidate', entityId: row.id, label: labelOf(row), detail: { file: row.file_name, jd_id: row.jd_id, jd_code: pad('JD', row.jd_id), jd_title: row.jd?.title } });
  res.json(cOut({ ...row, jd: undefined }));
}));
app.get('/api/candidates/:id', h(async (req, res) => {
  const c = await prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: CAND_SEL });
  if (!c) throw bad('Candidate not found', 404);
  res.json(cOut(c));
}));
app.get('/api/candidates/:id/file', h(async (req, res) => {   // original resume as uploaded
  const c = await prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { file_name: true, file_type: true, file_data: true, resume_text: true } });
  if (!c) throw bad('Candidate not found', 404);
  sendStored(res, { name: c.file_name, type: c.file_type, data: c.file_data, text: c.resume_text });
}));
app.get('/api/candidates/:id/analysis.pdf', h(async (req, res) => {
  const c = await prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { ...CAND_SEL, jd: { select: { id: true, title: true } } } });
  if (!c) throw bad('Candidate not found', 404);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${labelOf(c).replace(/[^\w-]+/g, '')}-analysis.pdf"` });
  res.send(await analysisPdf(c, c.jd));
}));
// Talent pool: re-score a candidate already in the system against another JD (no re-upload needed).
app.post('/api/candidates/:id/rematch', h(async (req, res) => {
  const [c, jd, settings] = await Promise.all([
    prisma.candidate.findFirst({ where: { id: id(req), ...mine(req) }, select: { id: true, file_name: true, file_type: true, file_data: true, resume_text: true } }),
    prisma.jd.findFirst({ where: { id: Number(req.body.jdId), ...mine(req), status: 'saved' }, select: MATCH_JD }),
    getSettings(req.user.id),
  ]);
  if (!c?.resume_text) throw bad('Candidate not found', 404);
  if (!jd) throw bad('Choose a saved JD.');
  const dup = await prisma.candidate.findFirst({ where: { ...mine(req), jd_id: jd.id, file_name: c.file_name, resume_text: c.resume_text }, select: CAND_SEL });
  if (dup) return res.json({ ...cOut(dup), existing: true });
  const analysis = await analyzeResume(jd, c.resume_text);
  analysis.required_years = requiredYears(jd, settings.min_exp);
  const sc = score(analysis, analysis.required_years);
  const row = await prisma.candidate.create({
    data: { file_name: c.file_name, file_type: c.file_type, file_data: c.file_data, resume_text: c.resume_text, jd_id: jd.id, user_id: req.user.id, name: analysis.candidate || null, analysis, score: sc.score, req_hit: sc.req_hit, req_total: sc.req_total },
    select: CAND_SEL,
  });
  logActivity(req.user.id, 'resume_analyzed', { entity: 'candidate', entityId: row.id, label: labelOf(row), detail: { file: row.file_name, jd_id: jd.id, jd_title: jd.title, jd_code: pad('JD', jd.id), score: row.score, req_hit: row.req_hit, req_total: row.req_total, rematch_of: c.id } });
  res.json(cOut(row));
}));

/* ---------------- Talent search: find people already analyzed (for any JD) who have these skills ----------------
   A term counts as found when the AI matched a skill of that name OR the resume text contains it. One row per person (best match). */
const words = v => String(v || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean).slice(0, 30);
const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = t => new RegExp(`(^|[^a-z0-9])${escRe(t.toLowerCase())}($|[^a-z0-9])`, 'i');
app.get('/api/talent', h(async (req, res) => {
  const q = req.query, terms = words(q.skills), min = Number(q.min) || 0, name = String(q.q || '').trim().toLowerCase(), role = String(q.role || '').trim().toLowerCase();
  const rows = await prisma.candidate.findMany({
    where: { ...mine(req), ...(q.short === '1' ? { shortlisted: true } : {}), ...(min ? { score: { gte: min } } : {}) },
    select: { ...CAND_SEL, resume_text: !!terms.length, jd: { select: { id: true, title: true } } }, orderBy: { id: 'desc' }, take: 5000,
  });
  const res1 = [];
  for (const r of rows) {
    if (name && !String(r.name || '').toLowerCase().includes(name) && !String(r.file_name || '').toLowerCase().includes(name)) continue;
    if (role && !String(r.jd?.title || '').toLowerCase().includes(role)) continue;
    const got = (r.analysis?.skills || []).filter(s => s.status !== 'missing').map(s => s.name.toLowerCase());
    const found = terms.filter(t => { const re = termRe(t); return got.some(g => g === t.toLowerCase() || re.test(g)) || re.test(r.resume_text || ''); });
    if (terms.length && (q.mode === 'all' ? found.length < terms.length : !found.length)) continue;
    res1.push({ ...cOut({ ...r, resume_text: undefined, jd: undefined }), job_role: r.jd?.title || null, found, hits: found.length });
  }
  const best = new Map();                                  // the same resume analyzed for several JDs -> keep its best row, list the roles
  for (const r of res1) {
    const k = (r.name || r.file_name || r.code).toLowerCase();
    const b = best.get(k);
    if (!b) { best.set(k, { ...r, roles: [r.job_role].filter(Boolean) }); continue; }
    if (r.job_role && !b.roles.includes(r.job_role)) b.roles.push(r.job_role);
    if (r.hits > b.hits || (r.hits === b.hits && r.score > b.score)) best.set(k, { ...r, roles: b.roles, shortlisted: b.shortlisted || r.shortlisted });
  }
  res.json([...best.values()].sort((a, b) => b.hits - a.hits || b.score - a.score).slice(0, 300).map(r => ({ ...r, analysis: undefined, top: (r.analysis?.skills || []).filter(s => s.status === 'matched').slice(0, 8).map(s => s.name), summary: r.analysis?.summary || '' })));
}));

/* ---------------- Saved searches (per panel) ---------------- */
app.use('/api/searches', searchRouter(h, bad, req => ({ user_id: req.user.id })));
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

// Dashboard: shortlisted profiles (with job role) + JD vs shortlisted tracker (daily / weekly / monthly) + per-role breakdown.
const PERIODS = { day: 14, week: 12, month: 12 };
app.get('/api/tracker', h(async (req, res) => {
  const period = PERIODS[req.query.period] ? req.query.period : 'week';
  const buckets = periodList(period, PERIODS[period]).map(b => ({ ...b, jds: 0, analyzed: 0, shortlisted: 0 }));
  const since = new Date(Date.now() - (period === 'day' ? 15 : period === 'week' ? 7 * 13 : 31 * 13) * 864e5);
  const [jds, cands, short, roles] = await Promise.all([
    prisma.jd.findMany({ where: { ...mine(req), created_at: { gte: since } }, select: { created_at: true } }),
    prisma.candidate.findMany({ where: { ...mine(req), created_at: { gte: since } }, select: { created_at: true } }),
    prisma.candidate.findMany({ where: { ...mine(req), shortlisted: true }, select: { ...sel(['id', 'name', 'file_name', 'score', 'req_hit', 'req_total', 'jd_id', 'shortlisted_at', 'created_at']), jd: { select: { id: true, title: true, client: true } } }, orderBy: [{ shortlisted_at: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }] }),
    prisma.jd.findMany({ where: mine(req), select: { id: true, title: true, created_at: true, _count: { select: { candidates: true } } }, orderBy: { id: 'desc' } }),
  ]);
  const byKey = new Map(buckets.map(b => [b.key, b]));
  const put = (d, f) => { const b = byKey.get(periodKey(d.getTime(), period)); if (b) b[f]++; };
  jds.forEach(j => put(j.created_at, 'jds')); cands.forEach(c => put(c.created_at, 'analyzed'));
  short.forEach(c => put(c.shortlisted_at || c.created_at, 'shortlisted'));
  const perRole = new Map(); short.forEach(c => perRole.set(c.jd_id, (perRole.get(c.jd_id) || 0) + 1));
  res.json({
    period, tz: TIMEZONE, buckets,
    shortlisted: short.map(c => ({ ...cOut(c), jd: undefined, job_role: c.jd?.title || null, jd_code: pad('JD', c.jd_id), client: c.jd?.client || null })),
    roles: roles.map(j => ({ id: j.id, code: pad('JD', j.id), title: j.title, created_at: j.created_at, analyzed: j._count.candidates, shortlisted: perRole.get(j.id) || 0 })),
  });
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
