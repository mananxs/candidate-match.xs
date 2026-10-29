const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (p, o = {}) => {
  const r = await fetch('/api' + p, o);
  const j = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (r.status === 401) { location.href = '/'; throw new Error('Please sign in again.'); }
  if (!r.ok) throw new Error(j?.error || r.statusText);
  return j;
};
const send = (p, body, method = 'POST') => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upload = (p, file, extra = {}) => { const fd = new FormData(); fd.append('file', file); Object.entries(extra).forEach(([k, v]) => fd.append(k, v)); return api(p, { method: 'POST', body: fd }); };
let _toastT;
function toast(msg, bad) {   // small confirmation message (bottom-right), auto-hides
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(_toastT); _toastT = setTimeout(() => t.classList.remove('show'), 2800);
}
// Run fn over items with at most n in flight at once (keeps AI rate limits happy while being ~n x faster).
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}
const CONC = 3;
const fmt = d => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

let view = 'dash', JDS = [], CANDS = [], ST = {}, SET = {}, SEL = new Set(), pick = null, USER = null;
let M = { jd: null, missing: [], text: '', files: [], results: [], busy: '', err: '', prog: null };
// Filters per panel (each can be saved as a named "saved search") + saved searches per panel
const FDEF = {
  cands: { q: '', jd: '', min: '', short: '', skill: '' },
  proc: { q: '', jd: '', st: '' },
  jds: { q: '', type: '', st: '' },
  talent: { skills: '', mode: 'any', q: '', role: '', min: '', short: '' },
};
const F = structuredClone(FDEF), SS = {};
let TR = { period: 'week', data: null }, TAL = { rows: [], ran: false, busy: false }, DQ = { q: '', rows: null };

const NAV = [['dash', 'Dashboard'], ['match', 'JD Matching'], ['bulk', 'Bulk Upload'], ['cands', 'Candidates'], ['talent', 'Talent Search'], ['proc', 'Processed Resumes'], ['jds', 'Job Descriptions'], ['set', 'Settings']];
const ICON = {
  dash: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  match: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  bulk: '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  talent: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/><path d="M8.5 11h5M11 8.5v5"/>',
  cands: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20c0-2.8-1.7-4.8-4-5.6"/>',
  proc: '<path d="M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/>',
  jds: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
  set: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  up: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
};
const svg = k => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;
// Interactive logo (style.css animates .lg-tile / .lg-fill on hover and click). Clicking it opens the dashboard.
const LOGO = '<svg class="lg" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect class="lg-tile" width="32" height="32" rx="9" fill="url(#lg)"/><rect x="7" y="13" width="18" height="6" rx="3" fill="#0b1020"/><rect class="lg-fill" x="7" y="13" width="10" height="6" rx="3" fill="#f5c518"/><circle class="lg-spark" cx="25" cy="7" r="1.6" fill="#fff"/></svg>';
const SKEL = '<div class="skel" style="height:34px;width:260px"></div><div class="skel" style="height:16px;width:380px;margin-bottom:24px"></div><div class="stats"><div class="skel" style="height:84px"></div><div class="skel" style="height:84px"></div><div class="skel" style="height:84px"></div></div><div class="skel" style="height:220px"></div>';
const HIDE = { surname: 'Surname', address: 'Address', email: 'Email', phone: 'Phone', linkedin: 'LinkedIn', github: 'GitHub', social: 'Social media', sites: 'Personal websites', dates: 'Exact employment dates', employer: 'Employer names', photos: 'Photos', latest: 'Hide latest/current employer' };
const SELS = { work_mode: ['Remote', 'Hybrid', 'On-site'], employment_type: ['Full-time', 'Part-time', 'Contract', 'Contract-to-hire', 'Internship', 'Freelance'] };
const FIELDS = [['title', 'Job title'], ['total_exp', 'Total experience (years)', 'number'], ['relevant_exp', 'Relevant experience (years)', 'number'], ['location', 'Location'], ['work_mode', 'Work mode', 'sel'], ['employment_type', 'Employment type', 'sel'],
  ['budget', 'Budget'], ['current_ctc', 'Current CTC'], ['expected_ctc', 'Expected CTC'], ['seniority', 'Seniority'], ['client', 'Client (internal only, never on masked resumes)']];
const AREAS = [['required_skills', 'Required skills (relevant)', ','], ['preferred_skills', 'Preferred skills', ','], ['hands_on', 'Hands-on experience required in (skills)', ','], ['responsibilities', 'Responsibilities', '\n'], ['technologies', 'Technologies / tools', ','], ['education', 'Education', '\n'], ['certifications', 'Certifications', '\n']];
const AR = new Set(AREAS.map(a => a[0]));

/* ---------- shared pieces ---------- */
const head = (t, s, r = '') => `<div class="pagehead"><div><h1>${t}</h1><p class="sub">${s}</p></div>${r}</div>`;
const status = () => (M.busy ? `<div class="spin">${esc(M.busy)}</div>` : '') + (M.err ? `<div class="err">${esc(M.err)}</div>` : '');
const savedJds = () => JDS.filter(j => j.status === 'saved');
const jdOpts = () => '<option value="">Select saved JD</option>' + savedJds().map(j => `<option value="${j.id}" ${M.jd?.id === j.id ? 'selected' : ''}>${j.code} · ${esc(j.title || 'Untitled')}</option>`).join('');
const jdOf = id => JDS.find(j => j.id === id);

// Analysis card + legend live in analysis.js (shared with the admin portal). Preferred matches are DARK green there.
const LEG = CM.LEG;
const resActs = c => `<a class="btn g2 sm" href="/api/candidates/${c.id}/analysis.pdf">Analysis PDF</a><a class="btn g2 sm" href="/api/candidates/${c.id}/file">Original resume</a>`;
const card = (c, i) => CM.card(c, i, { role: jdOf(c.jd_id)?.title || c.job_role, actions: c.id ? resActs(c) : '' });

/* ---------- saved searches (one bar per panel) ---------- */
async function loadSS(scope, force) { if (force || !SS[scope]) SS[scope] = await api('/searches?scope=' + scope); }
const isDefault = scope => JSON.stringify(F[scope]) === JSON.stringify(FDEF[scope]);
const ssBar = scope => `<div class="ssbar"><span class="ss-l">Saved searches</span>${(SS[scope] || []).map(x => `<span class="sschip"><a data-act="sapply" data-scope="${scope}" data-id="${x.id}" title="Apply">${esc(x.name)}</a><button data-act="sdel" data-scope="${scope}" data-id="${x.id}" title="Delete saved search" aria-label="Delete ${esc(x.name)}">×</button></span>`).join('') || '<span class="meta">None yet – set the filters, then save them to reuse when a similar JD comes in.</span>'}
  <span class="ss-r">${isDefault(scope) ? '' : `<button class="g2 sm" data-act="sclear" data-scope="${scope}">Clear filters</button>`}<button class="g2 sm" data-act="ssave" data-scope="${scope}">★ Save search</button></span></div>`;
// a filter control bound to F[scope][key]
const fIn = (scope, k, label, ph = '', type = 'text') => `<label>${label}<input type="${type}" data-flt="${scope}.${k}" value="${esc(F[scope][k])}" placeholder="${esc(ph)}" ${type === 'number' ? 'min="0" max="100"' : ''}></label>`;
const fSel = (scope, k, label, opts) => `<label>${label}<select data-flt="${scope}.${k}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(F[scope][k]) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
const roleOpts = () => [['', 'All job roles'], ...JDS.map(j => [j.id, `${j.code} · ${j.title || 'Untitled'}`])];
const has = (hay, q) => String(hay || '').toLowerCase().includes(String(q).trim().toLowerCase());

/* ---------- JD requirements form (auto-filled, missing details flagged for manual entry) ---------- */
function reqForm(jd) {
  const miss = k => M.missing.includes(k);
  const fld = ([k, label, t]) => {
    const v = jd[k] ?? '', m = miss(k), cls = m && v === '' ? 'miss' : '', pl = m ? 'Not found in JD – fill manually' : '';
    if (t === 'sel') {
      const o = SELS[k].slice(); if (v && !o.includes(v)) o.push(v);
      return `<label>${label}<select data-f="${k}" class="${cls}"><option value="">${m ? 'Not found – select' : ''}</option>${o.map(x => `<option ${x === v ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`;
    }
    return `<label>${label}<input data-f="${k}" type="${t || 'text'}" ${t === 'number' ? 'min="0" step="0.5"' : ''} value="${esc(v)}" class="${cls}" placeholder="${pl}"></label>`;
  };
  const area = ([k, label, sep]) => {
    const v = (jd[k] || []).join(sep === ',' ? ', ' : '\n'), m = miss(k);
    return `<label>${label} <span class="meta">(${sep === ',' ? 'comma or line separated' : 'one per line'})</span><textarea data-f="${k}" class="${m && !v ? 'miss' : ''}" placeholder="${m ? 'Not found in JD – fill manually' : ''}">${esc(v)}</textarea></label>`;
  };
  const n = M.missing.length;
  return `<div style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px"><div class="meta" style="margin-bottom:8px">Extracted requirements for <b>${jd.code}</b> — edit anything before matching.</div>
  ${n ? `<div class="banner">${n} detail${n > 1 ? 's were' : ' was'} not found in the JD. Fill ${n > 1 ? 'them' : 'it'} in manually below (optional) – highlighted fields.</div>` : ''}
  <div class="g3">${FIELDS.map(fld).join('')}</div><div class="grid" style="margin-top:12px">${AREAS.map(area).join('')}</div>
  <div class="row"><button data-act="savejd" ${M.busy ? 'disabled' : ''}>Save requirements</button>${jd.status === 'draft' ? '<span class="meta">Not saved yet</span>' : '<span class="tag ok">Saved</span>'}</div></div>`;
}
// Reads one form field. List fields (skills, responsibilities...) become arrays.
function readField(el) {
  const k = el.dataset.f, v = el.value;
  if (!AR.has(k)) return v;
  const sep = AREAS.find(a => a[0] === k)[2];
  return v.split(sep === ',' ? /[\n,;]+/ : /\n+/).map(x => x.trim()).filter(Boolean);
}
function collectForm() {
  const o = {};
  document.querySelectorAll('[data-f]').forEach(el => { o[el.dataset.f] = readField(el); });
  return o;
}
// Keep M.jd equal to what is typed, so a re-render (draw) never throws the user's edits away.
function syncField(el) { if (M.jd && el.dataset.f) M.jd[el.dataset.f] = readField(el); }
const missingOf = jd => [...FIELDS.filter(f => f[0] !== 'client').map(f => f[0]).filter(k => jd[k] == null || jd[k] === ''), ...AREAS.map(a => a[0]).filter(k => k !== 'hands_on' && !(jd[k] || []).length)];   // hands-on is optional

/* ---------- views ---------- */
const tierTag = sc => `<span class="tag ${CM.tier(sc)[1]}">${sc}%</span>`;
// Tracker chart: JDs vs shortlisted per day / week / month (grouped bars, hover = exact numbers, table below = same data)
const TRP = { day: 'Daily', week: 'Weekly', month: 'Monthly' };
const bucketName = (b, p) => { const d = new Date(b.from + 'T00:00:00Z'), o = { timeZone: 'UTC' };
  return p === 'month' ? d.toLocaleDateString('en-GB', { ...o, month: 'short', year: '2-digit' }) : p === 'day' ? d.toLocaleDateString('en-GB', { ...o, day: '2-digit', month: 'short' }) : 'wk ' + d.toLocaleDateString('en-GB', { ...o, day: '2-digit', month: 'short' }); };
function trackerCard() {
  const d = TR.data, p = TR.period;
  const seg = `<div class="seg">${Object.entries(TRP).map(([k, v]) => `<button class="${p === k ? 'on' : ''}" data-act="trp" data-p="${k}">${v}</button>`).join('')}</div>`;
  if (!d) return `<div class="card"><div class="row" style="justify-content:space-between;margin:0 0 10px"><h2 style="margin:0">JD vs Shortlisted</h2>${seg}</div><div class="skel" style="height:180px"></div></div>`;
  const bs = d.buckets.slice().reverse(), max = Math.max(1, ...bs.map(b => Math.max(b.jds, b.shortlisted)));
  const cur = d.buckets[0], tot = d.buckets.reduce((a, b) => ({ jds: a.jds + b.jds, sh: a.sh + b.shortlisted, an: a.an + b.analyzed }), { jds: 0, sh: 0, an: 0 });
  const curName = { day: 'Today', week: 'This week', month: 'This month' }[p];
  return `<div class="card"><div class="row" style="justify-content:space-between;margin:0 0 10px"><h2 style="margin:0">JD vs Shortlisted</h2>${seg}</div>
    <div class="trk-kpi"><div><small>${curName} · JDs</small><b>${cur.jds}</b></div><div><small>${curName} · resumes analyzed</small><b>${cur.analyzed}</b></div><div><small>${curName} · shortlisted</small><b>${cur.shortlisted}</b></div><div><small>Shown period · shortlist rate</small><b>${tot.an ? Math.round(100 * tot.sh / tot.an) : 0}%</b></div></div>
    <div class="chart-leg"><span><i class="sw s1"></i>JDs uploaded</span><span><i class="sw s2"></i>Candidates shortlisted</span></div>
    <div class="chart" role="img" aria-label="${TRP[p]} JDs uploaded versus candidates shortlisted">${bs.map(b => `<div class="cg" data-tip="${esc(bucketName(b, p))}: ${b.jds} JD${b.jds === 1 ? '' : 's'} · ${b.shortlisted} shortlisted · ${b.analyzed} analyzed"><div class="bars"><i class="s1" style="height:${100 * b.jds / max}%"></i><i class="s2" style="height:${100 * b.shortlisted / max}%"></i></div><span>${esc(bucketName(b, p))}</span></div>`).join('')}</div>
    <details class="tview"><summary>Show as table</summary><div class="tscroll"><table><tr><th>Period</th><th>JDs uploaded</th><th>Resumes analyzed</th><th>Shortlisted</th></tr>${d.buckets.map(b => `<tr><td>${esc(bucketName(b, p))}</td><td>${b.jds}</td><td>${b.analyzed}</td><td>${b.shortlisted}</td></tr>`).join('')}</table></div></details></div>`;
}
function V_dash() {
  const st = [['Resumes uploaded', ST.resumes], ['JDs uploaded', ST.jds], ['Resumes masked', ST.masked], ['Masking failed', ST.mask_failed, 1], ['Total candidates', ST.resumes], ['Shortlisted', ST.shortlisted]];
  const d = TR.data, sh = d?.shortlisted || [];
  const roles = (d?.roles || []).filter(r => r.analyzed || r.shortlisted).slice(0, 12);
  return head(`Welcome back, <span class="hello">${esc((USER?.name || '').split(' ')[0] || 'there')}</span>`, 'Your private hiring workspace — screening activity at a glance.',
    `<div class="dsearch"><input type="text" id="dq" data-dq value="${esc(DQ.q)}" placeholder="Search a candidate by name…" autocomplete="off" aria-label="Search candidates by name"><div id="dsr">${dqResults()}</div></div>`) +
    `<div class="stats">${st.map(s => `<div class="stat ${s[2] ? 'bad' : ''}"><small>${s[0]}</small><div>${s[1] ?? 0}</div></div>`).join('')}</div>
  ${trackerCard()}
  <div class="grid bento"><div class="card"><div class="row" style="justify-content:space-between;margin:0 0 10px"><h2 style="margin:0">Shortlisted profiles <span class="meta" style="font-weight:400">· ${sh.length}</span></h2></div>
    ${sh.length ? `<div class="tscroll"><table class="compact"><tr><th>Candidate</th><th>Job role</th><th>ATS</th><th>Shortlisted</th><th></th></tr>${sh.slice(0, 25).map(c => `<tr><td><b>${esc(c.label)}</b></td><td>${esc(c.job_role || '—')} <span class="meta">${c.jd_code}</span></td><td>${tierTag(c.score)}</td><td class="meta">${fmt(c.shortlisted_at || c.created_at)}</td><td style="white-space:nowrap"><button class="g2 sm" data-act="viewc" data-id="${c.id}">View</button></td></tr>`).join('')}</table></div>` : '<div class="empty"><b>No shortlisted candidates yet</b>Tick “Shortlist” on the Candidates page.</div>'}</div>
  <div class="card"><h2>Shortlisted by job role</h2>${roles.length ? `<div class="tscroll"><table class="compact" style="min-width:0"><tr><th>Job role</th><th>Analyzed</th><th>Shortlisted</th></tr>${roles.map(r => `<tr><td>${esc(r.title || 'Untitled')} <span class="meta">${r.code}</span></td><td>${r.analyzed}</td><td><b>${r.shortlisted}</b> <span class="meta">${r.analyzed ? Math.round(100 * r.shortlisted / r.analyzed) + '%' : ''}</span></td></tr>`).join('')}</table></div>` : '<span class="meta">None yet</span>'}</div></div>
  <div class="grid bento"><div class="card"><h2>Recent processed resumes</h2>${(ST.recent_candidates || []).map(x => `<div class="row" style="justify-content:space-between;margin:6px 0"><span><b>${esc(x.label)}</b> <span class="meta">${fmt(x.created_at)}</span></span><span class="tag ${x.mask_status === 'failed' ? 'bad' : ''}">${x.score}%${x.mask_status === 'failed' ? ' · Masking failed' : ''}</span></div>`).join('') || '<span class="meta">None yet</span>'}</div>
  <div class="card"><h2>Recent job descriptions</h2>${(ST.recent_jds || []).map(j => `<div style="margin:6px 0"><b>${j.code}</b> · ${esc(j.title || 'Untitled')} <span class="meta">${[j.employment_type, j.location].filter(Boolean).join(' · ')} ${fmt(j.created_at)}</span></div>`).join('') || '<span class="meta">None yet</span>'}</div></div>`;
}
function dqResults() {
  if (!DQ.q.trim() || DQ.rows === null) return '';
  return `<div class="dsr">${DQ.rows.slice(0, 8).map(c => `<a data-act="viewc" data-id="${c.id}"><b>${esc(c.name || c.label)}</b><span>${esc((c.roles || []).join(', ') || '—')}</span>${tierTag(c.score)}${c.shortlisted ? '<span class="tag ok">Shortlisted</span>' : ''}</a>`).join('') || '<div class="meta" style="padding:10px 12px">No candidate with that name</div>'}</div>`;
}

// Live progress while resumes are analyzed: overall bar + one line per file
function progress() {
  const P = M.prog; if (!P) return '';
  const done = P.items.filter(x => x.st === 'done' || x.st === 'fail').length, pct = Math.round(100 * done / P.items.length), live = done < P.items.length;
  const lbl = { wait: 'Queued', run: 'Analyzing…', done: 'Done', fail: 'Failed' };
  return `<div class="prog ${live ? 'live' : ''}"><div class="prog-h"><b>${live ? 'Analyzing resumes' : 'Analysis complete'}</b><span>${done} / ${P.items.length} · ${pct}%</span></div>
    <div class="prog-bar"><i style="width:${pct}%"></i></div><div class="prog-list">${P.items.map(x => `<div class="pi ${x.st}"><span class="pd"></span><span class="pn">${esc(x.name)}</span><span class="ps">${x.st === 'done' && x.score != null ? tierTag(x.score) : x.st === 'fail' ? `<span class="tag bad" title="${esc(x.err || '')}">Failed</span>` : lbl[x.st]}</span></div>`).join('')}</div></div>`;
}

function V_match(bulk) {
  const rs = M.results.slice().sort((a, b) => b.score - a.score || b.req_hit - a.req_hit);
  const jdBox = bulk
    ? `<div class="card"><h2>1 · Choose JD</h2><select data-sel="jd" style="max-width:360px">${jdOpts()}</select>${M.jd ? `<p class="meta">${esc(M.jd.title)} · ${(M.jd.required_skills || []).length} required, ${(M.jd.preferred_skills || []).length} preferred skills${(M.jd.hands_on || []).length ? ' · hands-on: ' + esc(M.jd.hands_on.join(', ')) : ''}</p>` : '<p class="meta">Add and save JDs on the Job Descriptions page first.</p>'}</div>`
    : `<div class="card"><h2>1 · Upload JD</h2><label>Or use a saved JD<select data-sel="jd" style="max-width:360px">${jdOpts()}</select></label>
       <div class="grid" style="margin-top:12px"><div class="drop" data-drop="jd"><div><span class="dz-ic">${svg('up')}</span><b>Upload JD</b>PDF, DOCX or TXT · max 10 MB · requirements are filled automatically</div></div>
       <textarea data-in="text" style="min-height:120px" placeholder="…or paste the job description here">${esc(M.text)}</textarea></div>
       <div class="row"><button data-act="extract" ${M.busy ? 'disabled' : ''}>Extract Requirements</button>${M.jd ? `<button class="dng" data-act="rmjd" ${M.busy ? 'disabled' : ''}>Remove JD</button>` : ''}</div>${M.jd ? reqForm(M.jd) : ''}</div>`;
  return head(bulk ? 'Bulk Resume Processing' : 'JD Match Analyzer', 'Any resume format works. The AI matches skills by meaning, scores each candidate and ranks them.') + jdBox +
    `<div class="card"><h2>2 · Upload Resume${bulk ? 's' : '(s)'}</h2><div class="drop" data-drop="res"><div><span class="dz-ic">${svg('up')}</span><b>Upload Resumes</b>Drag &amp; drop PDF, DOCX or TXT · max 10 MB each</div></div>
    <div>${M.files.map(f => `<span class="chip ${f.err ? 'bad' : ''}">${esc(f.name)}${f.err ? ': ' + esc(f.err) : ''}</span>`).join('')}</div>
    <div class="row"><button data-act="analyze" ${M.busy || !M.files.length ? 'disabled' : ''}>Analyze Match</button><button class="g2" data-act="reset">Clear</button>${M.jd?.status === 'saved' ? '<button class="g2" data-act="talentjd">Search past candidates for this JD</button>' : ''}</div>${progress()}${M.prog ? (M.err ? `<div class="err">${esc(M.err)}</div>` : '') : status()}</div>` +
    (rs.length ? LEG + rs.map(card).join('') : '');
}

/* Candidates: filters + saved searches, filtered in the browser (instant) */
const candRows = () => { const f = F.cands; return CANDS.filter(c => (!f.q || has(c.name, f.q) || has(c.label, f.q) || has(c.file_name, f.q)) && (!f.jd || String(c.jd_id) === String(f.jd)) && (!f.min || c.score >= +f.min)
  && (!f.short || (f.short === '1') === !!c.shortlisted) && (!f.skill || f.skill.split(/[,;]+/).map(x => x.trim()).filter(Boolean).every(t => (c.analysis?.skills || []).some(s => s.status !== 'missing' && has(s.name, t))))); };
const T_cands = () => { const rows = candRows(); return `<div class="meta tcount">${rows.length} of ${CANDS.length} candidates</div><div class="tscroll"><table><tr><th>Rank</th><th>Candidate</th><th>Job Role</th><th>ATS</th><th>Required</th><th>Shortlist</th><th></th></tr>${rows.map((c, i) => `<tr><td>${i + 1}</td><td><b>${esc(c.label)}</b></td><td>${esc(jdOf(c.jd_id)?.title || '—')}</td><td>${tierTag(c.score)}</td><td>${c.req_hit}/${c.req_total}</td>
    <td><input type="checkbox" data-act="short" data-id="${c.id}" ${c.shortlisted ? 'checked' : ''} aria-label="Shortlist ${esc(c.label)}"></td><td style="white-space:nowrap"><button class="g2" data-act="viewc" data-id="${c.id}">View</button> <button class="dng" data-act="delc" data-id="${c.id}">Delete</button></td></tr>`).join('') || `<tr><td colspan="7" class="meta">${CANDS.length ? 'No candidate matches these filters' : 'No candidates yet'}</td></tr>`}</table></div>`; };
function V_cands() {
  return head('Candidates', 'Ranked by ATS score, then required-skill coverage, then total skills matched.') + status() +
    `<div class="card fbar"><div class="g5">${fIn('cands', 'q', 'Candidate name', 'e.g. Priya')}${fSel('cands', 'jd', 'Job role', roleOpts())}${fIn('cands', 'skill', 'Has skills', 'e.g. Python, AWS')}${fIn('cands', 'min', 'Min ATS %', '0', 'number')}${fSel('cands', 'short', 'Shortlisted', [['', 'All'], ['1', 'Shortlisted only'], ['0', 'Not shortlisted']])}</div>${ssBar('cands')}</div>
    <div class="card flush" id="tbl">${T_cands()}</div>`;
}

/* Talent search: everyone ever analyzed (any JD), searched on the server incl. resume text */
const T_talent = () => {
  if (TAL.busy) return '<div class="spin" style="padding:16px">Searching your talent pool…</div>';
  if (!TAL.ran) return '<div class="empty"><b>Search your talent pool</b>Enter skills (or fill them from a JD) and press Search. Every resume you have ever analyzed is searched, whatever JD it was uploaded for.</div>';
  const terms = F.talent.skills.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  return `<div class="meta tcount">${TAL.rows.length} candidate${TAL.rows.length === 1 ? '' : 's'} found</div><div class="tscroll"><table><tr><th>Candidate</th>${terms.length ? '<th>Skills found</th>' : ''}<th>Analyzed for</th><th>Best ATS</th><th></th></tr>${TAL.rows.map(c => `<tr><td><b>${esc(c.name || c.label)}</b>${c.shortlisted ? ' <span class="tag ok">Shortlisted</span>' : ''}<div class="meta">${esc(c.file_name || '')}</div></td>
    ${terms.length ? `<td><div class="hitbar"><i style="width:${Math.round(100 * c.hits / terms.length)}%"></i></div><b>${c.hits}/${terms.length}</b> <span class="meta">${esc(c.found.join(', '))}</span></td>` : ''}<td>${esc(c.roles.join(', ') || '—')}</td><td>${tierTag(c.score)}</td>
    <td style="white-space:nowrap"><button class="g2 sm" data-act="viewc" data-id="${c.id}">View</button> <select class="sm" data-rm="${c.id}" aria-label="Re-match against JD"><option value="">Re-match to JD…</option>${savedJds().map(j => `<option value="${j.id}">${j.code} · ${esc(j.title || 'Untitled')}</option>`).join('')}</select></td></tr>`).join('') || `<tr><td colspan="5" class="meta">No one in your pool matches. Try “any skill”, fewer skills or a lower ATS.</td></tr>`}</table></div>`;
};
function V_talent() {
  return head('Talent Search', 'When a similar JD arrives, find people you have already screened – then re-match them to the new JD in one click (no re-upload).') + status() +
    `<div class="card fbar"><div class="g5">${fIn('talent', 'skills', 'Skills (comma separated)', 'e.g. React, Node.js, AWS')}${fSel('talent', 'mode', 'Match', [['any', 'Any of these skills'], ['all', 'All of these skills']])}${fIn('talent', 'q', 'Candidate name', '')}${fIn('talent', 'role', 'Job role contains', 'e.g. Backend')}${fIn('talent', 'min', 'Min ATS %', '0', 'number')}</div>
    <div class="row">${fSel('talent', 'short', '', [['', 'Everyone'], ['1', 'Shortlisted only']]).replace('<label>', '<label style="min-width:180px">')}<label style="min-width:240px">Fill skills from a JD<select data-act="tfill"><option value="">Choose JD…</option>${JDS.map(j => `<option value="${j.id}">${j.code} · ${esc(j.title || 'Untitled')}</option>`).join('')}</select></label><button data-act="tsearch" style="align-self:flex-end">Search</button></div>${ssBar('talent')}</div>
    <div class="card flush" id="tbl">${T_talent()}</div>`;
}
async function runTalent() {
  TAL.busy = true; TAL.ran = true; const t = $('#tbl'); if (t && view === 'talent') t.innerHTML = T_talent();
  try { TAL.rows = await api('/talent?' + new URLSearchParams(Object.entries(F.talent).filter(([, v]) => v !== ''))); } catch (e) { M.err = e.message; TAL.rows = []; }
  TAL.busy = false; if (view === 'talent') draw();
}

const procRows = () => { const f = F.proc; return CANDS.filter(c => (!f.q || has(c.name, f.q) || has(c.label, f.q) || has(c.file_name, f.q)) && (!f.jd || String(c.jd_id) === String(f.jd)) && (!f.st || c.mask_status === f.st)); };
const T_proc = () => {
  const st = c => c.mask_status === 'masked' ? '<span class="tag ok">Masked</span>' : c.mask_status === 'failed' ? `<span class="tag bad" title="${esc(c.mask_error || '')}">Masking failed</span>` : '<span class="tag">Not masked</span>';
  const rows = procRows();
  return `<div class="meta tcount">${rows.length} of ${CANDS.length} resumes</div><div class="tscroll"><table><tr><th><input type="checkbox" data-act="selall" title="Select all shown" ${rows.length && rows.every(c => SEL.has(c.id)) ? 'checked' : ''}></th><th>Candidate</th><th>Job Role</th><th>File</th><th>Date</th><th>Status</th><th></th></tr>${rows.map(c => `<tr><td><input type="checkbox" data-act="sel" data-id="${c.id}" ${SEL.has(c.id) ? 'checked' : ''}></td><td><b>${esc(c.label)}</b></td><td>${esc(jdOf(c.jd_id)?.title || '—')}</td><td>${esc(c.file_name)}</td><td>${fmt(c.created_at)}</td><td>${st(c)}</td>
    <td style="white-space:nowrap"><button data-act="mask" data-id="${c.id}" ${M.busy ? 'disabled' : ''}>${c.mask_status === 'masked' ? 'Reprocess' : 'Mask'}</button>
    ${c.mask_status === 'masked' ? `<button class="g2" data-act="preview" data-id="${c.id}">Preview &amp; edit</button> <a class="btn g2" href="/api/candidates/${c.id}/masked.pdf?wm=1&download=1">Download PDF</a>` : ''}</td></tr>`).join('') || `<tr><td colspan="7" class="meta">${CANDS.length ? 'Nothing matches these filters' : 'Nothing processed yet'}</td></tr>`}</table></div>`;
};
function V_proc() {
  return head('Processed Resumes', 'Anonymize per your privacy settings, review, clean up and download as a watermarked PDF.', `<div class="row" style="margin:0"><button data-act="maskSel" ${M.busy || !SEL.size ? 'disabled' : ''}>Reprocess Selected (${SEL.size})</button><button class="dng" data-act="delsel" ${M.busy || !SEL.size ? 'disabled' : ''}>Delete Selected (${SEL.size})</button></div>`) + status() +
    `<div class="card fbar"><div class="g5">${fIn('proc', 'q', 'Candidate / file', '')}${fSel('proc', 'jd', 'Job role', roleOpts())}${fSel('proc', 'st', 'Status', [['', 'All'], ['masked', 'Masked'], ['none', 'Not masked'], ['failed', 'Masking failed']])}</div>${ssBar('proc')}</div>
    <div class="card flush" id="tbl">${T_proc()}</div>`;
}

const jdRows = () => { const f = F.jds; return JDS.filter(j => (!f.q || [j.code, j.title, j.client, ...(j.required_skills || []), ...(j.preferred_skills || [])].some(x => has(x, f.q))) && (!f.type || j.employment_type === f.type) && (!f.st || j.status === f.st)); };
const T_jds = () => { const rows = jdRows(); return `<div class="meta tcount">${rows.length} of ${JDS.length} JDs</div><div class="tscroll"><table><tr><th>JD ID</th><th>Job title</th><th>Client</th><th>Cands</th><th>Required skills</th><th>Exp</th><th>Type</th><th>Location</th><th>Created</th><th></th></tr>${rows.map(j => `<tr><td>${j.code}</td><td>${esc(j.title || 'Untitled')} ${j.status === 'draft' ? '<span class="tag">draft</span>' : ''}</td><td>${esc(j.client || '—')}</td><td>${j.cand_count}</td>
    <td>${esc((j.required_skills || []).slice(0, 6).join(', ') || '—')}${(j.hands_on || []).length ? `<div class="meta">Hands-on: ${esc(j.hands_on.join(', '))}</div>` : ''}</td><td>${j.total_exp ? j.total_exp + '+ yrs' : '—'}</td><td>${esc(j.employment_type || '—')}</td><td>${esc(j.location || '—')}</td><td>${fmt(j.created_at)}</td>
    <td style="white-space:nowrap"><button class="g2" data-act="edjd" data-id="${j.id}">Edit</button> <button class="g2" data-act="matchjd" data-id="${j.id}">Match</button> <a class="btn g2" href="/api/jds/${j.id}/file" title="${j.file_name ? 'Download ' + esc(j.file_name) : 'Download JD text'}">JD file</a> <button class="dng" data-act="deljd" data-id="${j.id}">Delete</button></td></tr>`).join('') || `<tr><td colspan="10" class="meta">${JDS.length ? 'No JD matches these filters' : 'No JDs yet'}</td></tr>`}</table></div>`; };
function V_jds() {
  return head('Job Descriptions', 'Client names are stored internally only and never appear on an anonymized resume.', `<button data-act="upjd" ${M.busy ? 'disabled' : ''}>Upload JD</button>`) + status() +
    `<div class="card fbar"><div class="g5">${fIn('jds', 'q', 'Search title, client, skill', '')}${fSel('jds', 'type', 'Employment type', [['', 'All'], ...SELS.employment_type.map(x => [x, x])])}${fSel('jds', 'st', 'Status', [['', 'All'], ['saved', 'Saved'], ['draft', 'Draft']])}</div>${ssBar('jds')}</div>
    <div class="card flush" id="tbl">${T_jds()}</div>`;
}
const TBL = { cands: T_cands, proc: T_proc, jds: T_jds };

function V_set() {
  return head('Settings', 'Everything here applies to your account only.') + status() + `<div class="card"><h2>Account</h2><div class="acct">${USER?.picture ? `<img src="${esc(USER.picture)}" alt="" referrerpolicy="no-referrer">` : ''}<div><b>${esc(USER?.name || 'Recruiter')}</b><div class="meta">${esc(USER?.email || '')} · signed in with Google</div></div><button class="g2" data-act="logout" style="margin-left:auto">Sign out</button></div></div>
  <div class="card"><h2>Resume Settings</h2><p class="meta">Template: Standard ATS (default) – one consistent layout for every candidate.</p>
  <label>Default minimum experience (years) – used when a JD states none<input type="number" min="0" id="s_min" value="${SET.min_exp}" style="max-width:120px;display:block"></label></div>
  <div class="card"><h2>Privacy Settings</h2><div class="priv">${Object.entries(HIDE).map(([k, v]) => `<label><input type="checkbox" data-hide="${k}" ${SET.hide?.[k] ? 'checked' : ''}>${v}</label>`).join('')}</div>
  <div class="row"><label style="flex:1;max-width:340px">Watermark text<input type="text" id="s_wm" value="${esc(SET.watermark_text)}"></label></div>
  <div class="card" style="margin-top:12px"><b>Watermark logo</b> <span class="meta">(optional – replaces the default XS mark on the watermarked PDF)</span><div class="row">
  ${SET.has_logo ? `<img src="/api/settings/logo?${Date.now()}" style="height:48px;border:1px solid var(--line);border-radius:6px;background:#fff"><button class="dng" data-act="rmlogo">Remove logo</button>` : '<span class="meta">No logo set – the default XS mark + text above is used.</span>'}
  <button class="g2" data-act="uplogo">Upload logo</button><span class="meta">PNG or JPEG, max 1 MB</span></div></div>
  <div class="row"><button data-act="saveset">Save privacy settings</button><span class="tag ok" id="setnote" hidden>✓ Saved</span></div><p class="meta">Changes apply to newly masked resumes. For existing ones, select them on Processed Resumes and click Reprocess Selected.</p></div>
  <div class="card"><h2>Data Retention</h2><p class="meta">Your JDs and candidates are stored in a private workspace that only your account can open, and are never auto-deleted. You can still remove an individual JD or resume at any time. To have all of your data permanently removed, please contact your administrator.</p></div>`;
}

function drawNav() {
  const nm = USER?.name || USER?.email || '';
  $('#nav').innerHTML = `<a class="brand" href="/app" data-home title="Go to dashboard">${LOGO}<span class="bt">CandidateMatch</span></a>
  <div class="navlinks">${NAV.map(n => `<a data-nav="${n[0]}" class="${view === n[0] ? 'on' : ''}">${svg(n[0])}${n[1]}</a>`).join('')}</div>
  <div class="userbox">${USER?.picture ? `<img src="${esc(USER.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="ph">${esc((nm[0] || '?').toUpperCase())}</span>`}<div><b>${esc(USER?.name || 'Recruiter')}</b><small>${esc(USER?.email || '')}</small></div><button class="g2" data-act="logout" title="Sign out">${svg('out')}</button></div>`;
}
function draw() {
  drawNav();
  $('#main').innerHTML = { dash: V_dash, match: () => V_match(0), bulk: () => V_match(1), cands: V_cands, talent: V_talent, proc: V_proc, jds: V_jds, set: V_set }[view]();
}
const SWR = new Set(['dash', 'cands', 'proc', 'jds', 'talent']), LOADED = new Set();   // pages with no editable form fields
const loadTracker = () => api('/tracker?period=' + TR.period).then(r => TR.data = r);
async function go(v) {
  const changed = v !== view; view = v; M.err = '';
  const cached = changed && SWR.has(v) && LOADED.has(v);              // seen before: show it instantly, refresh underneath
  if (cached) draw();
  else if (changed) { drawNav(); $('#main').innerHTML = SKEL; }       // instant feedback while data loads
  try {
    const jobs = [];                                                  // fetch in parallel (was one after another)
    if (v === 'dash') jobs.push(api('/stats').then(r => ST = r), loadTracker());
    if (['match', 'bulk', 'jds', 'cands', 'proc', 'talent'].includes(v)) jobs.push(api('/jds').then(r => JDS = r));
    if (v === 'cands' || v === 'proc') jobs.push(api('/candidates').then(r => { CANDS = r; SEL = new Set([...SEL].filter(i => r.some(c => c.id === i))); }));
    if (FDEF[v]) jobs.push(loadSS(v));
    if (v === 'set') jobs.push(api('/settings').then(r => SET = r));
    await Promise.all(jobs);
    LOADED.add(v);
  } catch (e) { M.err = e.message; }
  if (view === v) draw();
}
const dlg = h => { $('#dlg').innerHTML = h + '<div class="row"><button onclick="$(\'#dlg\').close()">Close</button></div>'; $('#dlg').showModal(); };
const busy = async (msg, fn) => { M.busy = msg; M.err = ''; draw(); try { await fn(); } catch (e) { M.err = e.message; } M.busy = ''; draw(); };

/* ---------- actions ---------- */
async function extractJd(file, text) {
  await busy(file ? `Reading ${file.name} and extracting requirements…` : 'Extracting requirements…', async () => {
    const jd = file ? await upload('/jds/extract', file) : await send('/jds/extract', { text });
    M.jd = jd; M.prog = null; M.missing = missingOf(jd); JDS = [{ ...jd, cand_count: 0 }, ...JDS.filter(j => j.id !== jd.id)];
  });
}
/* A JD was deleted: remove it (and its candidates) from the list, the Analyze Match screen and the selections. */
function forgetJd(jdId) {
  JDS = JDS.filter(j => j.id !== jdId);
  CANDS = CANDS.filter(c => c.jd_id !== jdId);
  SEL = new Set([...SEL].filter(i => CANDS.some(c => c.id === i)));
  M.results = M.results.filter(c => c.jd_id !== jdId);
  if (M.jd?.id === jdId) { M.jd = null; M.missing = []; M.text = ''; M.files = []; M.prog = null; M.err = ''; }
}
async function maskOne(id) {
  const c = await api(`/candidates/${id}/mask`, { method: 'POST' });
  const i = CANDS.findIndex(x => x.id === id); if (i > -1) CANDS[i] = c;
  if (c.mask_status === 'failed') M.err = `Masking failed for ${c.label}: ${c.mask_error || 'error'}`;
}
/* ---------- compare (original vs masked / last saved vs current edits) ---------- */
const diffTok = t => (t.match(/\S+|\n/g) || []);
function diffOps(a, b) {   // token diff -> [{t:'=',v}|{t:'-',v}|{t:'+',v}]
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb), n = A.length, m = B.length, ops = [];
  A.length === 0 && B.length === 0 || (() => {
    if (n * m > 16e6) { A.forEach(v => ops.push({ t: '-', v })); B.forEach(v => ops.push({ t: '+', v })); return; }   // too big: show as one block
    const w = m + 1, L = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ t: '=', v: A[i] }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) ops.push({ t: '-', v: A[i++] }); else ops.push({ t: '+', v: B[j++] });
    }
    while (i < n) ops.push({ t: '-', v: A[i++] }); while (j < m) ops.push({ t: '+', v: B[j++] });
  })();
  return [...a.slice(0, s).map(v => ({ t: '=', v })), ...ops, ...a.slice(ea).map(v => ({ t: '=', v }))];
}
function renderDiff(oldT, newT, labels) {
  const ops = diffOps(diffTok(oldT), diffTok(newT));
  const rem = ops.filter(o => o.t === '-' && o.v !== '\n').length, add = ops.filter(o => o.t === '+' && o.v !== '\n').length;
  const same = ops.filter(o => o.t === '=' && o.v !== '\n').length;
  if (!rem && !add) return `<div class="cmp-sum same"><b>No changes.</b> ${labels[1]} is identical to ${labels[0].toLowerCase()}.</div>`;
  // merge consecutive tokens of the same kind into one span; newlines stay as line breaks
  let html = '', cur = null, buf = [];
  const flush = () => { if (!buf.length) return; const txt = esc(buf.join(' ')); html += cur === '=' ? txt : `<${cur === '-' ? 'del' : 'ins'}>${txt}</${cur === '-' ? 'del' : 'ins'}>`; buf = []; };
  for (const o of ops) {
    if (o.v === '\n') { if (o.t === '-') continue; flush(); html += '\n'; cur = null; continue; }   // line breaks come from the new text
    if (o.t !== cur) { flush(); cur = o.t; if (html && !html.endsWith('\n')) html += ' '; }
    buf.push(o.v);
  }
  flush();
  const pct = Math.round(100 * rem / Math.max(1, rem + same));
  return `<div class="cmp-sum"><span class="tag bad">${rem} removed / replaced</span> <span class="tag ok">${add} added</span> <span class="tag">${pct}% of ${labels[0].toLowerCase()} changed</span></div><pre class="cmp">${html}</pre>`;
}
function drawCompare() {
  const box = $('#cmp'); if (!box) return;
  const base = $('#cmpbase').value, cur = $('#mt').value;
  const o = window._cmp || {};
  box.innerHTML = base === 'orig'
    ? renderDiff(o.original || '', cur, ['Original resume', 'Masked version'])
    : renderDiff(o.saved || '', cur, ['Last saved version', 'Current edits']);
}
function showPane(which) {
  const cmp = which === 'cmp';
  $('#pv').hidden = cmp; $('#cmpwrap').hidden = !cmp;
  document.querySelectorAll('[data-pane]').forEach(b => b.classList.toggle('on', b.dataset.pane === which));
  if (cmp) drawCompare();
}
function openPreview(id) {
  api(`/candidates/${id}/masked`).then(m => {
    window._cmp = { original: m.original, saved: m.text };
    dlg(`<h2>${m.code} – masked resume</h2><p class="meta">Edit the text on the left to remove anything that was missed, then save to refresh the PDF preview.</p>
    <div class="grid"><div><textarea id="mt" spellcheck="false">${esc(m.text)}</textarea>
    <div class="row"><input type="text" id="rm" placeholder="Remove everywhere (a name, company, email…)" style="flex:1"><button class="g2" data-act="rmall">Remove</button></div>
    <div class="row"><button data-act="msave" data-id="${id}">Save &amp; refresh preview</button><a class="btn g2" href="/api/candidates/${id}/masked.pdf?wm=1&download=1">Download (with XS watermark)</a><a class="btn g2" href="/api/candidates/${id}/masked.pdf?wm=0&download=1">Download (no watermark)</a></div></div>
    <div><div class="seg" style="margin-bottom:8px"><button class="on" data-act="pane" data-pane="pdf">PDF preview</button><button data-act="pane" data-pane="cmp">Compare changes</button></div>
    <iframe id="pv" src="/api/candidates/${id}/masked.pdf?wm=1&t=${Date.now()}"></iframe>
    <div id="cmpwrap" hidden><label>Compare current text against
      <select id="cmpbase" data-act="cmpbase"><option value="orig">Original resume (what masking changed)</option><option value="saved">Last saved version (my edits)</option></select></label>
      <div class="cmp-legend"><del>removed / replaced</del> <ins>added</ins></div><div id="cmp"></div></div></div></div>`);
  }).catch(e => { M.err = e.message; draw(); });
}

async function viewCand(id) {
  try {
    const c = CANDS.find(x => x.id === id) || M.results.find(x => x.id === id) || await api('/candidates/' + id);
    dlg(card(c, 0) + LEG);
  } catch (x) { toast(x.message, true); }
}
// Saved searches: save the current filters of a panel under a name / apply / delete
async function saveSearch(scope) {
  const name = (prompt('Name this search (e.g. "Senior Java – Pune")', '') || '').trim(); if (!name) return;
  try { await send('/searches', { scope, name, query: F[scope] }); await loadSS(scope, true); toast(`Saved search “${name}”`); draw(); } catch (x) { toast(x.message, true); }
}
const refreshTable = () => { if (TBL[view] && $('#tbl')) $('#tbl').innerHTML = TBL[view](); };

document.addEventListener('click', async e => {
  const hm = e.target.closest('[data-home]');
  if (hm) { e.preventDefault(); hm.classList.remove('ping'); void hm.offsetWidth; hm.classList.add('ping'); return go('dash'); }
  const n = e.target.closest('[data-nav]'); if (n) return go(n.dataset.nav);
  const el = e.target.closest('[data-act],[data-drop]'); if (!el) return;
  if (el.dataset.drop) { pick = el.dataset.drop; $('#fi').multiple = pick === 'res'; $('#fi').accept = '.pdf,.docx,.txt'; return $('#fi').click(); }
  const a = el.dataset.act, id = +el.dataset.id;
  if (a === 'tfill') return;                                   // a <select>: handled on change
  if (a === 'trp') { TR.period = el.dataset.p; TR.data = null; draw(); try { await loadTracker(); } catch (x) { M.err = x.message; } return view === 'dash' && draw(); }
  if (a === 'ssave') return saveSearch(el.dataset.scope);
  if (a === 'sapply') { const sc = el.dataset.scope, x = (SS[sc] || []).find(q => q.id === id); if (!x) return; F[sc] = { ...FDEF[sc], ...x.query }; draw(); if (sc === 'talent') runTalent(); return toast(`Applied “${x.name}”`); }
  if (a === 'sdel') { const sc = el.dataset.scope, x = (SS[sc] || []).find(q => q.id === id); if (!x || !confirm(`Delete saved search “${x.name}”?`)) return; await api('/searches/' + id, { method: 'DELETE' }); await loadSS(sc, true); return draw(); }
  if (a === 'sclear') { const sc = el.dataset.scope; F[sc] = structuredClone(FDEF[sc]); if (sc === 'talent') { TAL = { rows: [], ran: false, busy: false }; } return draw(); }
  if (a === 'tsearch') return runTalent();
  if (a === 'talentjd') { if (!M.jd) return; F.talent = { ...FDEF.talent, skills: (M.jd.required_skills || []).join(', ') }; await go('talent'); return runTalent(); }
  if (a === 'upjd') { pick = 'upjd'; $('#fi').multiple = false; $('#fi').accept = '.pdf,.docx,.txt'; return $('#fi').click(); }
  if (a === 'uplogo') { pick = 'logo'; $('#fi').multiple = false; $('#fi').accept = '.png,.jpg,.jpeg'; return $('#fi').click(); }
  if (a === 'reset') { M.files = []; M.results = []; M.err = ''; M.prog = null; return draw(); }
  if (a === 'extract') { if ((M.text || '').trim().length < 40) { M.err = 'Paste or upload a JD first'; return draw(); } return extractJd(null, M.text); }
  if (a === 'savejd') {
    const form = collectForm();   // read the typed values FIRST - busy() redraws the form from old data
    return busy('Saving requirements…', async () => {
      const jd = await send(`/jds/${M.jd.id}`, form, 'PUT');
      M.jd = jd; M.missing = [];
      JDS = JDS.map(j => j.id === jd.id ? { ...j, ...jd, cand_count: j.cand_count } : j);
    });
  }
  if (a === 'analyze') {
    if (!M.jd) { M.err = 'Select or extract a JD first'; return draw(); }
    if (M.jd.status !== 'saved') { M.err = 'Click "Save requirements" first so the JD is locked in.'; return draw(); }
    const files = M.files.filter(f => f.file); M.results = []; M.err = '';
    M.prog = { items: files.map(f => ({ name: f.name, st: 'wait' })) };
    M.busy = 'Analyzing…';
    await pool(files, CONC, async (f, i) => {
      const it = M.prog.items[i]; it.st = 'run'; draw();
      try { const c = await upload('/candidates', f.file, { jdId: M.jd.id }); M.results.push(c); it.st = 'done'; it.score = c.score; }
      catch (x) { it.st = 'fail'; it.err = x.message; M.err += `${f.name}: ${x.message}  `; }
      draw();
    });
    M.busy = ''; M.files = []; return draw();
  }
  if (a === 'matchjd' || a === 'edjd') { M.jd = await api('/jds/' + id); M.missing = M.jd.status === 'draft' ? missingOf(M.jd) : []; M.results = []; return go('match'); }
  if (a === 'deljd') { if (confirm('Delete this JD and its candidates?')) { await api('/jds/' + id, { method: 'DELETE' }); forgetJd(id); return go('jds'); } return; }
  if (a === 'logout') { await api('/auth/logout', { method: 'POST' }); location.href = '/'; return; }
  if (a === 'rmjd') {
    if (!M.jd) return;
    const n = jdOf(M.jd.id)?.cand_count || 0;
    if (!confirm(`Remove ${M.jd.code}${n ? ` and its ${n} candidate${n > 1 ? 's' : ''}` : ''}? This cannot be undone.`)) return;
    const gone = M.jd.id;
    return busy('Removing JD…', async () => { await api('/jds/' + gone, { method: 'DELETE' }); forgetJd(gone); JDS = await api('/jds'); });
  }
  if (a === 'selall') { if (e.target.checked) procRows().forEach(c => SEL.add(c.id)); else SEL.clear(); return draw(); }
  if (a === 'delsel') {
    if (!SEL.size || !confirm(`Delete ${SEL.size} candidate${SEL.size > 1 ? 's' : ''}? This cannot be undone.`)) return;
    return busy('Deleting…', async () => { await send('/candidates/bulk-delete', { ids: [...SEL] }); SEL.clear(); CANDS = await api('/candidates'); });
  }
  if (a === 'delc') { await api('/candidates/' + id, { method: 'DELETE' }); return go(view); }
  if (a === 'short') {
    try { const c = await send('/candidates/' + id, { shortlisted: e.target.checked }, 'PATCH'); const i = CANDS.findIndex(x => x.id === id); if (i > -1) CANDS[i] = c; toast(c.shortlisted ? `${c.label} shortlisted for ${jdOf(c.jd_id)?.title || 'this role'}` : `${c.label} removed from shortlist`); }
    catch (x) { e.target.checked = !e.target.checked; toast(x.message, true); }
    return;
  }
  if (a === 'sel') { e.target.checked ? SEL.add(id) : SEL.delete(id); return draw(); }
  if (a === 'viewc') return viewCand(id);
  if (a === 'mask') return busy('Masking…', () => maskOne(id));
  if (a === 'maskSel') return busy('Reprocessing…', async () => { await pool([...SEL], CONC, async i => { M.busy = 'Masking ' + (CANDS.find(c => c.id === i)?.label || '') + '…'; draw(); await maskOne(i); }); SEL.clear(); });
  if (a === 'preview') return openPreview(id);
  if (a === 'rmall') {
    const t = $('#rm').value.trim(); if (!t) return;
    $('#mt').value = $('#mt').value.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').replace(/ {2,}/g, ' ').replace(/ +\n/g, '\n'); $('#rm').value = ''; return;
  }
  if (a === 'pane') return showPane(el.dataset.pane);
  if (a === 'msave') { await send(`/candidates/${id}/masked`, { text: $('#mt').value }, 'PUT'); window._cmp.saved = $('#mt').value; if (!$('#cmpwrap').hidden) drawCompare(); $('#pv').src = `/api/candidates/${id}/masked.pdf?wm=1&t=${Date.now()}`; return; }
  if (a === 'saveset') {
    const hide = {}; document.querySelectorAll('[data-hide]').forEach(c => hide[c.dataset.hide] = c.checked);
    if (el.disabled) return;
    const label = el.textContent, body = { hide, watermark_text: $('#s_wm').value, min_exp: $('#s_min').value };
    el.disabled = true; el.textContent = 'Saving…';
    try {
      await send('/settings', body, 'PUT');
      SET = { ...SET, hide, watermark_text: body.watermark_text, min_exp: Number(body.min_exp) || 0 };
      const n = $('#setnote'); if (n) n.hidden = false;
      toast('Privacy settings saved');
    } catch (x) { toast('Could not save settings: ' + x.message, true); }
    el.disabled = false; el.textContent = label; return;
  }
  if (a === 'rmlogo') { await api('/settings/logo', { method: 'DELETE' }); return go('set'); }
});

$('#fi').onchange = async e => {
  const fs = [...e.target.files]; e.target.value = ''; if (!fs.length) return;
  if (pick === 'logo') { try { await upload('/settings/logo', fs[0]); } catch (x) { M.err = x.message; } return go('set'); }
  if (pick === 'jd' || pick === 'upjd') { M.results = []; if (pick === 'upjd') view = 'match'; return extractJd(fs[0]); }
  for (const f of fs) M.files.push(f.size > 10485760 ? { name: f.name, err: 'over 10 MB' } : { name: f.name, file: f });
  draw();
};
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset?.flt?.startsWith('talent.')) runTalent(); if (e.key === 'Escape' && 'dq' in (e.target.dataset || {})) { DQ.q = ''; DQ.rows = null; e.target.value = ''; $('#dsr').innerHTML = ''; } });
document.addEventListener('dragover', e => { if (e.target.closest('[data-drop]')) e.preventDefault(); });
document.addEventListener('drop', e => {
  const d = e.target.closest('[data-drop]'); if (!d) return; e.preventDefault();
  pick = d.dataset.drop; const fs = [...e.dataTransfer.files];
  if (pick === 'jd') return extractJd(fs[0]);
  fs.forEach(f => M.files.push({ name: f.name, file: f })); draw();
});
let _cmpT;
let _dqT;
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.flt && t.tagName === 'INPUT') { const [sc, k] = t.dataset.flt.split('.'); F[sc][k] = t.value; return refreshTable(); }
  if ('dq' in t.dataset) {                                    // dashboard: search candidates by name (debounced)
    DQ.q = t.value; clearTimeout(_dqT);
    if (!DQ.q.trim()) { DQ.rows = null; $('#dsr').innerHTML = ''; return; }
    _dqT = setTimeout(async () => { const q = DQ.q; try { const r = await api('/talent?q=' + encodeURIComponent(q.trim())); if (q === DQ.q) { DQ.rows = r; $('#dsr') && ($('#dsr').innerHTML = dqResults()); } } catch { /* ignore */ } }, 220);
    return;
  }
  if (t.id === 'mt' && $('#cmpwrap') && !$('#cmpwrap').hidden) { clearTimeout(_cmpT); _cmpT = setTimeout(drawCompare, 250); }
  if (t.dataset.in) M[t.dataset.in] = t.value;
  if (t.dataset.hide !== undefined || t.id === 's_wm' || t.id === 's_min') { const n = $('#setnote'); if (n) n.hidden = true; }
  if (t.dataset.f) syncField(t);
  if (t.dataset.f) { const empty = t.value === ''; t.classList.toggle('miss', empty && M.missing.includes(t.dataset.f)); }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'cmpbase') return drawCompare();
  if (t.dataset.sel === 'jd') { M.jd = t.value ? await api('/jds/' + t.value) : null; M.missing = []; M.results = []; M.prog = null; draw(); }
  if (t.dataset.flt && t.tagName === 'SELECT') { const [sc, k] = t.dataset.flt.split('.'); F[sc][k] = t.value; if (sc === 'talent') { if (TAL.ran) runTalent(); return; } return refreshTable(); }
  if (t.dataset.act === 'tfill') { const j = jdOf(+t.value); if (!j) return; F.talent.skills = [...(j.required_skills || []), ...(j.preferred_skills || [])].join(', '); draw(); return runTalent(); }
  if (t.dataset.rm && t.value) {                             // talent search: re-match a past candidate to another JD
    const j = jdOf(+t.value), cid = +t.dataset.rm; t.disabled = true;
    toast(`Re-matching against ${j?.code}…`);
    try { const c = await send(`/candidates/${cid}/rematch`, { jdId: +t.value }); toast(c.existing ? `Already matched to ${j?.code} (ATS ${c.score}%)` : `Added to ${j?.code} · ATS ${c.score}%`); dlg(card(c, 0) + LEG); }
    catch (x) { toast(x.message, true); }
    t.disabled = false; t.value = ''; return;
  }
  if (t.dataset.f) syncField(t);
  if (t.dataset.f && t.tagName === 'SELECT') t.classList.toggle('miss', t.value === '' && M.missing.includes(t.dataset.f));
});
// Boot: confirm who is signed in, then open the dashboard.
(async () => {
  try { USER = await api('/me'); } catch { return; }   // api() already sent us to the landing page on 401
  go('dash');
})();
