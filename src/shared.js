// Small helpers shared by the HR API (server.js) and the admin API (admin.js).
export const pad = (p, id) => `${p}-${String(id).padStart(3, '0')}`;
const TITLES = /^(mr|mrs|ms|miss|mx|dr|prof|er)\.?$/i;
export const firstName = full => String(full || '').trim().split(/\s+/).find(w => w && !TITLES.test(w)) || '';
export const labelOf = c => firstName(c.name) || pad('CAND', c.id);

/** Required vs candidate experience, as shown in the admin "Shortlisted" table. */
export function expInfo(analysis) {
  const req = Number(analysis?.required_years) > 0 ? Number(analysis.required_years) : null;
  const cy = analysis?.candidate_years == null || analysis.candidate_years === '' || !isFinite(+analysis.candidate_years) ? null : +analysis.candidate_years;
  const missing = req != null && cy != null && cy < req ? Math.round((req - cy) * 10) / 10 : 0;
  return { required: req, candidate: cy, missing };
}

/** Candidate row (+ its jd) -> API shape used by both front-ends. */
export function candView(r) {
  if (!r) return r;
  const { jd, user, ...rest } = r;
  return {
    ...rest, code: pad('CAND', r.id), label: labelOf(r),
    job_role: jd?.title || null, jd_code: pad('JD', r.jd_id), exp: expInfo(r.analysis),
    ...(jd ? { jd: { id: jd.id, title: jd.title, client: jd.client } } : {}),
    ...(user ? { user } : {}),
  };
}

/** Case-insensitive "whole token" test, so "R" does not match every word and "C++" / "Node.js" still work. */
export function hasTerm(text, term) {
  const t = String(term || '').trim();
  if (!t) return false;
  const re = new RegExp('(?<![a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', 'i');
  return re.test(text || '');
}

export const fileExt = name => (String(name || '').split('.').pop() || '').toLowerCase();
export const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain; charset=utf-8' };
export const safeName = (s, fb = 'file') => String(s || fb).replace(/[^\w.\- ]+/g, '').trim() || fb;
