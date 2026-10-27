// Match-analysis card, shared by the HR workspace (app.js) and the admin portal (admin.js).
// Exposes window.CM = { card, LEG, exp }. Wrapped in an IIFE so it never clashes with the apps' own globals.
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const yrs = n => `${n} yr${n === 1 ? '' : 's'}`;
  const r1 = n => Math.round(n * 10) / 10;

  // Verdict + colour tier for the score ring
  const tier = s => s >= 75 ? ['Strong fit', 't-hi'] : s >= 50 ? ['Good fit', 't-mid'] : s >= 30 ? ['Partial fit', 't-lo'] : ['Low fit', 't-bad'];

  // Skill colours (ANALYSIS ONLY): matched required = green, matched preferred = DARK green, everything else = black (neutral).
  function row(s, withEvidence) {
    const m = s.status === 'matched';
    const c = m && s.type === 'required' ? 'g' : m && s.type === 'preferred' ? 'dg' : 'k';
    const icon = s.status === 'matched' ? '✓' : s.status === 'partial' ? '◐' : '✕';
    const ho = !s.hands_on ? '' : s.status === 'missing' ? '<span class="ho">Hands-on required</span>'
      : s.hands_on_shown ? '<span class="ho ok">Hands-on ✓</span>' : '<span class="ho warn">Hands-on not shown</span>';
    const tags = (s.status === 'partial' ? '<span class="ho">partial</span>' : '') + (s.status === 'missing' && s.type === 'preferred' ? '<span class="ho">missing</span>' : '') + ho;
    return `<div class="sk ${c} st-${s.status}"><span class="sk-ic" aria-hidden="true">${icon}</span><div><span class="sk-n">${esc(s.name)}</span>${tags}${withEvidence && s.evidence ? `<small>${esc(s.evidence)}</small>` : ''}</div></div>`;
  }

  // Experience: required vs candidate, and how much is missing (replaces the old "(needs N)").
  function exp(a) {
    const req = Number(a?.required_years) > 0 ? Number(a.required_years) : null;
    const cy = a?.candidate_years == null || a.candidate_years === '' || !isFinite(+a.candidate_years) ? null : +a.candidate_years;
    const miss = req != null && cy != null && cy < req ? r1(req - cy) : 0, extra = req != null && cy != null && cy > req ? r1(cy - req) : 0;
    const pct = req && cy != null ? Math.min(100, Math.round(100 * cy / req)) : cy != null ? 100 : 0;
    const verdict = req == null ? '<span class="tag">No requirement set</span>' : cy == null ? '<span class="tag">Not stated in resume</span>'
      : miss ? `<span class="tag bad">Missing ${yrs(miss)}</span>` : `<span class="tag ok">Meets requirement${extra ? ` (+${yrs(extra)})` : ''}</span>`;
    return `<div class="xp"><div class="xp-row"><span>Required experience <b>${req != null ? yrs(req) : '—'}</b></span><span>Candidate experience <b>${cy != null ? yrs(cy) : '—'}</b></span>${verdict}</div>
      <div class="meter ${miss ? 'short' : ''}"><i style="width:${pct}%"></i></div></div>`;
  }

  const meter = (label, hit, total, cls = '') => total ? `<div class="mt"><div class="mt-h"><span>${label}</span><b>${r1(hit)} / ${total}</b></div><div class="meter ${cls}"><i style="width:${Math.round(100 * hit / total)}%"></i></div></div>` : '';

  const ord = { required: 0, preferred: 1, other: 2 };
  /** c = candidate row ({ label, score, req_hit, req_total, file_name, analysis }), i = rank index, o = { role, actions } */
  function card(c, i, o = {}) {
    const a = c.analysis || {}, sk = (a.skills || []).slice().sort((x, y) => ord[x.type] - ord[y.type]);
    const pref = sk.filter(s => s.type === 'preferred');
    const matched = sk.filter(s => s.type !== 'preferred' && s.status !== 'missing'), missing = sk.filter(s => s.type !== 'preferred' && s.status === 'missing');
    const prefHit = pref.reduce((n, s) => n + (s.status === 'matched' ? 1 : s.status === 'partial' ? .5 : 0), 0);
    const [verdict, t] = tier(c.score || 0);
    const cols = [
      `<div class="col c-ok"><h3><span class="dotk g"></span>Matched skills <em>${matched.length}</em></h3>${matched.map(s => row(s, 1)).join('') || '<span class="meta">None</span>'}</div>`,
      pref.length ? `<div class="col c-pref"><h3><span class="dotk dg"></span>Preferred skills <em>${pref.filter(s => s.status !== 'missing').length} / ${pref.length}</em></h3>${pref.map(s => row(s, 1)).join('')}</div>` : '',
      `<div class="col c-miss"><h3><span class="dotk k"></span>Missing skills <em>${missing.length}</em></h3>${missing.map(s => row(s, 0)).join('') || '<span class="meta">None – full coverage</span>'}</div>`,
    ].filter(Boolean);
    return `<div class="res ${t}"><div class="head"><div class="scorebox"><div class="rank">#${i + 1}</div><div class="ring" style="--p:${c.score}"><div class="pct">${c.score}%</div></div><span class="verdict">${verdict}</span></div>
      <div class="hd-main"><div class="name">${esc(c.label)}</div><div class="meta">ATS match for <b>${esc(o.role || 'role')}</b> · ${esc(c.file_name || '')}</div>
      <div class="meters">${meter('Required skills covered', c.req_hit || 0, c.req_total || 0)}${meter('Preferred skills', prefHit, pref.length, 'dg')}</div>${exp(a)}</div></div>
      <div class="box n${cols.length}">${cols.join('')}</div>
      ${a.summary ? `<p class="summary">${esc(a.summary)}</p>` : ''}${o.actions ? `<div class="row res-act">${o.actions}</div>` : ''}</div>`;
  }

  const LEG = '<div class="legend"><span>Matched skills:</span><span class="g">● Green = required</span><span class="dg">● Dark green = preferred</span><span class="k">● Black = other / missing</span><span><span class="ho ok">Hands-on ✓</span> = JD asks for hands-on experience and the resume shows it</span></div>';

  window.CM = { card, LEG, exp, tier };
})();
