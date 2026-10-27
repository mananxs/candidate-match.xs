// Shared by the HR API (server.js) and the admin API (admin.js): analysis report text, experience summary and file downloads.
import { buildPdf } from './maskpdf.js';

export const pad = (p, id) => `${p}-${String(id).padStart(3, '0')}`;
const TITLES = /^(mr|mrs|ms|miss|mx|dr|prof|er)\.?$/i;
export const firstName = full => String(full || '').trim().split(/\s+/).find(w => w && !TITLES.test(w)) || '';
export const labelOf = c => firstName(c.name) || pad('CAND', c.id);
export const jobRole = jd => jd ? `${jd.title || 'Untitled role'}` : '—';

/** Required vs candidate experience -> { required, candidate, missing, extra } (years, null when unknown). */
export function experienceGap(a) {
  const req = Number(a?.required_years) > 0 ? Number(a.required_years) : null;
  const cy = a?.candidate_years == null || a.candidate_years === '' || !isFinite(+a.candidate_years) ? null : +a.candidate_years;
  const r1 = n => Math.round(n * 10) / 10;
  return { required: req, candidate: cy, missing: req != null && cy != null && cy < req ? r1(req - cy) : 0, extra: req != null && cy != null && cy > req ? r1(cy - req) : 0 };
}

const yrs = n => `${n} yr${n === 1 ? '' : 's'}`;
const skillLine = s => `- ${s.name}${s.status === 'partial' ? ' (partial)' : ''}${s.hands_on ? (s.status === 'missing' ? ' [hands-on required]' : s.hands_on_shown ? ' [hands-on shown]' : ' [hands-on NOT shown]') : ''}${s.evidence ? ': ' + s.evidence : ''}`;

const orNone = l => l.length ? l : ['- None'];
/** Plain text in the maskpdf.js mini-format (@ headline, # section, - bullet). */
export function analysisText(c, jd, owner) {
  const a = c.analysis || {}, sk = a.skills || [], e = experienceGap(a);
  const pref = sk.filter(s => s.type === 'preferred');
  const out = [
    `@ ${jobRole(jd)}${jd ? ' (' + pad('JD', jd.id) + ')' : ''} · ATS ${c.score ?? '–'}% · required skills ${c.req_hit ?? '–'}/${c.req_total ?? '–'}`,
    '# CANDIDATE',
    `- Name: ${c.name || labelOf(c)}`, `- Resume file: ${c.file_name || '—'}`,
    ...(owner ? [`- Analyzed by: ${owner}`] : []),
    `- Shortlisted: ${c.shortlisted ? 'Yes' + (c.shortlisted_at ? ' (' + new Date(c.shortlisted_at).toISOString().slice(0, 10) + ')' : '') : 'No'}`,
    '# SUMMARY', a.summary || '—',
    '# EXPERIENCE',
    `- Required experience: ${e.required != null ? yrs(e.required) : 'not specified'}`,
    `- Candidate experience: ${e.candidate != null ? yrs(e.candidate) : 'not stated in resume'}`,
    `- ${e.missing ? 'Missing experience: ' + yrs(e.missing) : e.required != null && e.candidate != null ? 'Meets the requirement' + (e.extra ? ' (+' + yrs(e.extra) + ')' : '') : 'Gap could not be determined'}`,
    '# MATCHED SKILLS', ...orNone(sk.filter(s => s.type !== 'preferred' && s.status !== 'missing').map(skillLine)),
    ...(pref.length ? ['# PREFERRED SKILLS', ...pref.map(s => skillLine({ ...s, name: s.name + (s.status === 'missing' ? ' (missing)' : '') }))] : []),
    '# MISSING SKILLS', ...orNone(sk.filter(s => s.type !== 'preferred' && s.status === 'missing').map(skillLine)),
  ];
  return out.join('\n');
}
export const analysisPdf = (c, jd, owner) => buildPdf(analysisText(c, jd, owner), { code: `${labelOf(c)} - match analysis`, watermark: false, footer: 'CandidateMatch analysis' });

const safeName = s => String(s || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
/** Sends the original uploaded file, or the extracted text as .txt when the file was uploaded before files were kept. */
export function sendStored(res, { name, type, data, text }) {
  if (data) {
    res.set({ 'Content-Type': type || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeName(name)}"` });
    return res.send(Buffer.from(data));
  }
  if (!text) return res.status(404).json({ error: 'File not available.' });
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeName(String(name || 'file').replace(/\.\w+$/, ''))}.txt"` });
  res.send(text);
}

/** CSV cell, safe against spreadsheet formula injection. */
export const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
