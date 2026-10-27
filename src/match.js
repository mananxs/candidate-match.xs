// A skill needs hands-on experience when the JD's hands_on list names it (same word, or one contains the other).
export function isHandsOn(jd, name) {
  const k = String(name).trim().toLowerCase();
  return (jd.hands_on || []).some(h => { const x = String(h).trim().toLowerCase(); return x && (x === k || (k.length > 2 && x.includes(k)) || (x.length > 2 && k.includes(x))); });
}

/** Builds the fixed skill list that every resume is scored against. */
export function buildSkills(jd) {
  const seen = new Set(), out = [];
  const add = (arr, type) => (arr || []).forEach(n => {
    const k = String(n).trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); out.push({ name: String(n).trim(), type, ...(isHandsOn(jd, n) ? { hands_on: true } : {}) }); }
  });
  add(jd.required_skills, 'required');
  add(jd.preferred_skills, 'preferred');
  add(jd.technologies, 'other');
  return out.slice(0, 40);
}

export const requiredYears = (jd, minExp) =>
  Number(jd.relevant_exp) > 0 ? Number(jd.relevant_exp) : Number(jd.total_exp) > 0 ? Number(jd.total_exp) : Number(minExp) || null;

/** required 3 / preferred 1.5 / other 0.6; partial = half credit; experience shortfall penalty (max -30%). */
export function score(analysis, reqYears) {
  const W = { required: 3, preferred: 1.5, other: 0.6 }, S = { matched: 1, partial: 0.5, missing: 0 };
  let got = 0, max = 0;
  for (const s of analysis.skills) { const w = W[s.type] ?? 0.6; max += w; got += w * (S[s.status] ?? 0); }
  let p = max ? got / max : 0;
  const cy = analysis.candidate_years;
  if (reqYears && cy != null && cy < reqYears) p *= Math.max(0.7, cy / reqYears);
  const req = analysis.skills.filter(s => s.type === 'required');
  return {
    score: Math.round(p * 100),
    req_hit: req.reduce((a, s) => a + (S[s.status] ?? 0), 0),
    req_total: req.length,
  };
}
