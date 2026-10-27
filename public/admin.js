// CandidateMatch Admin - a standalone app (own sign-in at /admin, own session, own API at /admin-api).
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (p, o = {}) => {
  const r = await fetch('/admin-api' + p, o);
  const j = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (r.status === 401) { location.href = '/admin'; throw new Error('Please sign in again.'); }
  if (!r.ok) throw new Error(j?.error || r.statusText);
  return j;
};
const send = (p, body, method = 'POST') => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let view = 'admin', ME = null, M = { busy: '', err: '' };
let AD = { ov: null, items: [], cursor: null, f: { user_id: '', action: '', from: '', to: '' } };          // dashboard
let AS = { rows: [], f: { user_id: '', q: '', role: '', min: '', from: '', to: '' } };   // Shortlisted page
const SS = {};                                                                          // saved searches per panel
let AU = { id: 0, profile: null, period: 'week', buckets: [], sel: null, items: [], cursor: null, f: { action: '', from: '', to: '' } };   // one user
const LOGO = '<svg class="lg" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect class="lg-tile" width="32" height="32" rx="9" fill="url(#lg)"/><rect x="7" y="13" width="18" height="6" rx="3" fill="#0b1020"/><rect class="lg-fill" x="7" y="13" width="10" height="6" rx="3" fill="#f5c518"/><circle class="lg-spark" cx="25" cy="7" r="1.6" fill="#fff"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3z"/></svg>';
const ICON_DASH = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
const ICON_OUT = '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></svg>';
const SKEL = '<div class="skel" style="height:34px;width:260px"></div><div class="skel" style="height:16px;width:380px;margin-bottom:24px"></div><div class="stats"><div class="skel" style="height:84px"></div><div class="skel" style="height:84px"></div><div class="skel" style="height:84px"></div></div><div class="skel" style="height:220px"></div>';

const head = (t, s, r = '') => `<div class="pagehead"><div><h1>${t}</h1><p class="sub">${s}</p></div>${r}</div>`;
const status = () => (M.busy ? `<div class="spin">${esc(M.busy)}</div>` : '') + (M.err ? `<div class="err">${esc(M.err)}</div>` : '');

/* ---------- Admin Panel (only for accounts listed in ADMIN_EMAILS) ---------- */
const ACOLS = [['jds', 'JDs'], ['analyzed', 'AI matched'], ['masked', 'Masked'], ['mask_failed', 'Mask failed'], ['pdfs', 'PDFs'], ['shortlisted', 'Shortlisted'], ['deleted', 'Deleted'], ['logins', 'Sign-ins']];
const ACT = {
  login: ['Signed in'], jd_extracted: ['JD uploaded'], jd_saved: ['JD saved'], jd_deleted: ['JD deleted', 'bad'],
  resume_analyzed: ['Resume analyzed (AI match)', 'ok'], resume_failed: ['Analysis failed', 'bad'], resume_masked: ['Resume masked', 'ok'], mask_failed: ['Masking failed', 'bad'],
  mask_edited: ['Masked resume edited'], pdf_downloaded: ['Masked PDF downloaded'], shortlisted: ['Shortlisted', 'ok'], unshortlisted: ['Unshortlisted'],
  candidate_deleted: ['Resume deleted', 'bad'], settings_updated: ['Settings updated'], logo_changed: ['Watermark logo changed'], admin_wipe: ['All data deleted by admin', 'bad'],
};
const ATZ = () => AD.ov?.tz || AU.profile?.tz || 'UTC';
const fmtDT = d => new Date(d).toLocaleString('en-GB', { timeZone: ATZ(), day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDay = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const periodName = (b, per) => per === 'month' ? new Date(b.from + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }) : `${fmtDay(b.from)} – ${fmtDay(b.to)}`;
function detailText(r) {
  const d = r.detail || {}, l = r.label || '';
  const jd = d.jd_code ? `${d.jd_code}${d.jd_title ? ' · ' + d.jd_title : ''}` : (d.jd_title || '');
  const t = {
    jd_extracted: () => `${l} · ${d.title || 'Untitled'} · from ${d.file || 'file'}`,
    jd_saved: () => `${l} · ${d.title || 'Untitled'}`,
    jd_deleted: () => `${l} · ${d.title || 'Untitled'} · ${d.resumes_removed || 0} resume(s) removed with it`,
    resume_analyzed: () => `${l} · ${d.file || ''} → ${jd} · ATS ${d.score ?? '–'}% · required ${d.req_hit ?? '–'}/${d.req_total ?? '–'}`,
    resume_failed: () => `${d.file || ''} → ${l} ${d.jd_title || ''} · ${d.error || ''}`,
    resume_masked: () => `${l} · ${d.file || ''}`,
    mask_failed: () => `${l} · ${d.file || ''}${d.error ? ' · ' + d.error : ''}`,
    mask_edited: () => `${l} · ${d.file || ''}`,
    pdf_downloaded: () => `${l} · ${d.file || ''} · ${d.watermark ? 'with' : 'without'} watermark`,
    shortlisted: () => `${l} · ${d.file || ''}${jd ? ' → ' + jd : ''}`, unshortlisted: () => `${l} · ${d.file || ''}${jd ? ' → ' + jd : ''}`,
    candidate_deleted: () => `${l} · ${d.file || ''}${d.bulk ? ' · bulk delete' : ''}`,
    logo_changed: () => d.change || '',
    admin_wipe: () => `${d.resumes ?? 0} resume(s) and ${d.jds ?? 0} JD(s) deleted by ${d.by || 'admin'}`,
  }[r.action];
  return esc(t ? t() : '');
}
const avatar = u => u?.picture ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer" class="avs">` : `<span class="avs ph">${esc(((u?.name || u?.email || '?')[0] || '?').toUpperCase())}</span>`;
const userLink = u => `<a class="ulink" data-act="openuser" data-id="${u.id}">${avatar(u)}<span><b>${esc(u.name || u.email)}</b><small>${esc(u.name ? u.email : '')}</small></span></a>`;
const actTag = a => `<span class="tag ${ACT[a]?.[1] || ''}">${esc(ACT[a]?.[0] || a)}</span>`;
const fmtD = d => new Date(d).toLocaleDateString('en-GB', { timeZone: ATZ(), day: '2-digit', month: 'short', year: 'numeric' });
const tierTag = sc => `<span class="tag ${CM.tier(sc || 0)[1]}">${sc ?? '–'}%</span>`;

/* ---------- saved searches (admin-owned) ---------- */
async function loadSS(scope, force) { if (force || !SS[scope]) SS[scope] = await api('/searches?scope=' + scope); }
const ssBar = (scope, dirty) => `<div class="ssbar"><span class="ss-l">Saved searches</span>${(SS[scope] || []).map(x => `<span class="sschip"><a data-act="sapply" data-scope="${scope}" data-id="${x.id}" title="Apply">${esc(x.name)}</a><button data-act="sdel" data-scope="${scope}" data-id="${x.id}" title="Delete saved search" aria-label="Delete ${esc(x.name)}">×</button></span>`).join('') || '<span class="meta">None yet – set the filters, then save them.</span>'}
  <span class="ss-r">${dirty ? `<button class="g2 sm" data-act="sclear" data-scope="${scope}">Clear filters</button>` : ''}<button class="g2 sm" data-act="ssave" data-scope="${scope}">★ Save search</button></span></div>`;
const SCOPES = { a_short: () => AS.f, a_log: () => AD.f };
const SDEF = { a_short: { user_id: '', q: '', role: '', min: '', from: '', to: '' }, a_log: { user_id: '', action: '', from: '', to: '' } };

/* ---------- shortlisted candidates (all users) ---------- */
const shortQ = () => new URLSearchParams(Object.entries(AS.f).filter(([, v]) => v !== ''));
async function loadShort() { AS.rows = await api('/shortlisted?' + shortQ()); }
const expTxt = e => !e ? '—' : `${e.required != null ? e.required + ' yrs req.' : 'no req.'} · ${e.candidate != null ? e.candidate + ' yrs' : 'not stated'}${e.missing ? ` <span class="tag bad">−${e.missing} yrs</span>` : e.required != null && e.candidate != null ? ' <span class="tag ok">meets</span>' : ''}`;
const fileBtns = c => `<a class="btn g2 sm" href="/admin-api/candidates/${c.id}/resume" title="Original resume">Resume</a><a class="btn g2 sm" href="/admin-api/candidates/${c.id}/jd" title="Job description file">JD</a><a class="btn g2 sm" href="/admin-api/candidates/${c.id}/analysis.pdf" title="Match analysis as PDF">Analysis PDF</a>${c.mask_status === 'masked' ? `<a class="btn g2 sm" href="/admin-api/candidates/${c.id}/masked.pdf" title="Masked resume PDF">Masked</a>` : ''}`;
const shortTable = (rows, showUser, compact) => `<div class="tscroll"><table class="${compact ? 'compact' : ''}"><tr><th>Shortlisted</th><th>Candidate</th><th>Job role</th>${showUser ? '<th>Recruiter</th>' : ''}<th>ATS</th>${compact ? '' : '<th>Required</th><th>Experience</th>'}<th></th></tr>${rows.map(c => `<tr><td style="white-space:nowrap">${fmtD(c.shortlisted_at || c.created_at)}</td><td><b>${esc(c.name || c.label)}</b><div class="meta">${esc(c.file_name || '')}</div></td>
  <td>${esc(c.job_role || '—')}<div class="meta">${c.jd_code}${c.jd?.client ? ' · ' + esc(c.jd.client) : ''}</div></td>${showUser ? `<td>${c.user ? userLink(c.user) : '—'}</td>` : ''}<td>${tierTag(c.score)}</td>${compact ? '' : `<td>${c.req_hit}/${c.req_total}</td><td style="white-space:nowrap">${expTxt(c.exp)}</td>`}
  <td><div class="acts"><button class="sm" data-act="aview" data-id="${c.id}">View analysis</button>${compact ? '' : fileBtns(c)}</div></td></tr>`).join('') || `<tr><td colspan="8" class="meta">No shortlisted candidates for this selection</td></tr>`}</table></div>`;

function V_ashort() {
  const F = AS.f, users = AD.ov?.users || [], dirty = Object.values(F).some(Boolean);
  return head('Shortlisted Candidates', 'Every profile shortlisted by every recruiter – with the job role, the analysis already performed and the original resume / JD files.', `<a class="btn g2" href="/admin-api/shortlisted.csv?${shortQ()}">Download CSV (with analysis)</a>`) + status() +
    `<div class="card fbar"><div class="g3" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
      <label>Recruiter<select data-sf="user_id"><option value="">All recruiters</option>${users.map(u => `<option value="${u.id}" ${String(F.user_id) === String(u.id) ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join('')}</select></label>
      <label>Candidate name<input type="text" data-sf="q" value="${esc(F.q)}" placeholder="name or file"></label><label>Job role<input type="text" data-sf="role" value="${esc(F.role)}" placeholder="e.g. Java Developer"></label>
      <label>Min ATS %<input type="number" min="0" max="100" data-sf="min" value="${esc(F.min)}"></label><label>Shortlisted from<input type="date" data-sf="from" value="${esc(F.from)}"></label><label>To<input type="date" data-sf="to" value="${esc(F.to)}"></label></div>${ssBar('a_short', dirty)}</div>
    <div class="card flush"><div class="meta tcount">${AS.rows.length} shortlisted candidate${AS.rows.length === 1 ? '' : 's'}</div>${shortTable(AS.rows, true)}</div>`;
}

const actOpts = sel => '<option value="">All activity</option>' + Object.entries(ACT).map(([k, v]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${esc(v[0])}</option>`).join('');

async function loadAdminLog(reset = true) {
  const q = new URLSearchParams({ limit: 50 });
  Object.entries(AD.f).forEach(([k, v]) => v && q.set(k, v));
  if (!reset && AD.cursor) q.set('cursor', AD.cursor);
  const r = await api('/activity?' + q);
  AD.items = reset ? r.items : AD.items.concat(r.items); AD.cursor = r.next_cursor;
}
async function loadAdmin() { AD.ov = await api('/overview'); await loadAdminLog(true); }
const auQuery = () => { const q = new URLSearchParams(); Object.entries(AU.f).forEach(([k, v]) => v && q.set(k, v)); return q; };
async function loadAUReport() { AU.buckets = (await api(`/users/${AU.id}/report?period=${AU.period}`)).buckets; }
async function loadAULog(reset = true) {
  const q = auQuery(); q.set('user_id', AU.id); q.set('limit', 50);
  if (!reset && AU.cursor) q.set('cursor', AU.cursor);
  const r = await api('/activity?' + q);
  AU.items = reset ? r.items : AU.items.concat(r.items); AU.cursor = r.next_cursor;
}
async function loadAdminUser() { AU.profile = await api('/users/' + AU.id); await Promise.all([loadAUReport(), loadAULog(true)]); }

const logTable = (items, showUser, more, scope) => `<div class="tscroll"><table><tr><th>Date &amp; time</th>${showUser ? '<th>User</th>' : ''}<th>Activity</th><th>Details</th></tr>${items.map(r => `<tr><td style="white-space:nowrap">${fmtDT(r.created_at)}</td>${showUser ? `<td>${userLink(r.user)}</td>` : ''}<td>${actTag(r.action)}</td><td>${detailText(r)}</td></tr>`).join('') || `<tr><td colspan="${showUser ? 4 : 3}" class="meta">No activity for this selection</td></tr>`}</table></div>${more ? `<div class="row"><button class="g2" data-act="amore" data-scope="${scope}" ${M.busy ? 'disabled' : ''}>Load more</button></div>` : ''}`;

function V_admin() {
  const ov = AD.ov || { totals: {}, users: [] }, t = ov.totals, F = AD.f;
  const st = [['Users', t.users], ['Active users (7 days)', t.active_7d], ['Actions (7 days)', t.actions_7d], ['Actions (30 days)', t.actions_30d]];
  const sh = ov.shortlisted || [];
  return head('Admin Panel', 'Everything your team does in CandidateMatch. Click a user to open their dedicated dashboard.') + status() +
    `<div class="stats">${st.map(s => `<div class="stat"><small>${s[0]}</small><div>${s[1] ?? 0}</div></div>`).join('')}</div>
    <div class="card"><div class="row" style="justify-content:space-between;margin:0 0 10px"><h2 style="margin:0">Users</h2><input type="text" data-asearch placeholder="Search name or email…" style="max-width:260px;margin:0"></div>
    <div class="tscroll"><table><tr><th>User</th><th>Last active</th><th>Last sign-in</th>${ACOLS.slice(0, 4).map(c => `<th>${c[1]}</th>`).join('')}<th>Total</th></tr>${ov.users.map(u => `<tr data-q="${esc((u.name || '') + ' ' + u.email).toLowerCase()}"><td>${userLink(u)}</td><td>${u.last_activity ? fmtDT(u.last_activity) : '—'}</td><td>${fmtDT(u.last_login)}</td>${ACOLS.slice(0, 4).map(c => `<td>${u.counts[c[0]]}</td>`).join('')}<td><b>${u.counts.total}</b></td></tr>`).join('') || '<tr><td colspan="8" class="meta">No users yet</td></tr>'}</table></div></div>
    <div class="card"><div class="row" style="justify-content:space-between;margin:0 0 10px"><h2 style="margin:0">Recently shortlisted profiles <span class="meta" style="font-weight:400">· ${t.shortlisted ?? 0} in total</span></h2><button class="g2" data-nav="ashort">Open Shortlisted page →</button></div>
    ${shortTable(sh, true, true)}</div>
    <div class="card"><h2>Activity Log <span class="meta" style="font-weight:400">· times in ${esc(ov.tz || '')}</span></h2>
    <div class="g3" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px">
      <label>User<select data-af="user_id"><option value="">All users</option>${ov.users.map(u => `<option value="${u.id}" ${String(F.user_id) === String(u.id) ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join('')}</select></label>
      <label>Activity<select data-af="action">${actOpts(F.action)}</select></label>
      <label>From<input type="date" data-af="from" value="${esc(F.from)}"></label><label>To<input type="date" data-af="to" value="${esc(F.to)}"></label></div>
    ${ssBar('a_log', Object.values(F).some(Boolean))}
    ${logTable(AD.items, true, AD.cursor, 'admin')}</div>`;
}

function V_adminUser() {
  const P = AU.profile; if (!P) return head('User', '') + status() + '<div class="card"><button class="g2" data-act="aback">← Back to Admin Panel</button></div>';
  const u = P.user, c = P.counts, F = AU.f, q = auQuery().toString();
  const bar = AU.period === 'month' ? 'Month' : 'Week';
  return `<div class="row" style="margin:0 0 14px"><button class="g2" data-act="aback">← Admin Panel</button></div>` +
    head(esc(u.name || u.email), `${esc(u.email)} · joined ${fmtDay(u.created_at.slice(0, 10))} · last sign-in ${fmtDT(u.last_login)}`) + status() +
    `<div class="stats">${[['Resumes analyzed (AI matched)', c.analyzed], ['Resumes masked', c.masked], ['Masking failed', c.mask_failed, 1], ['JDs uploaded', c.jds], ['PDFs downloaded', c.pdfs], ['Shortlisted', c.shortlisted], ['Deleted (resumes + JDs)', c.deleted], ['Sign-ins', c.logins]].map(s => `<div class="stat ${s[2] ? 'bad' : ''}"><small>${s[0]}</small><div>${s[1] ?? 0}</div></div>`).join('')}</div>
    <p class="meta" style="margin:-6px 0 18px">All-time totals from the activity log · currently stored: ${P.stored.resumes} resume(s) (${P.stored.masked} masked, ${P.stored.shortlisted} shortlisted) and ${P.stored.jds} JD(s).</p>
    <div class="card"><h2>Shortlisted profiles <span class="meta" style="font-weight:400">· ${(P.shortlisted || []).length}</span></h2>${shortTable(P.shortlisted || [], false)}</div>
    <div class="card"><div class="row" style="justify-content:space-between;margin:0 0 10px"><h2 style="margin:0">${AU.period === 'month' ? 'Monthly' : 'Weekly'} record</h2>
      <div class="seg"><button class="${AU.period === 'week' ? 'on' : ''}" data-act="aper" data-p="week">Weekly</button><button class="${AU.period === 'month' ? 'on' : ''}" data-act="aper" data-p="month">Monthly</button></div></div>
    <p class="meta" style="margin:0 0 8px">${AU.period === 'week' ? 'Last 12 weeks, Monday to Sunday.' : 'Last 12 months.'} Click “View” to list every activity in that period below.</p>
    <div class="tscroll"><table><tr><th>${bar}</th>${ACOLS.map(x => `<th>${x[1]}</th>`).join('')}<th>Total</th><th></th></tr>${AU.buckets.map(b => `<tr class="${AU.sel === b.key ? 'sel' : ''}"><td style="white-space:nowrap"><b>${esc(periodName(b, AU.period))}</b></td>${ACOLS.map(x => `<td>${b.counts[x[0]] || '<span class="meta">0</span>'}</td>`).join('')}<td><b>${b.counts.total}</b></td><td><button class="g2" data-act="abucket" data-key="${b.key}" data-from="${b.from}" data-to="${b.to}">View</button></td></tr>`).join('')}</table></div></div>
    <div class="card"><div class="row" style="justify-content:space-between;margin:0 0 10px"><h2 style="margin:0">Activity log <span class="meta" style="font-weight:400">· times in ${esc(P.tz)}</span></h2><a class="btn g2" href="/admin-api/users/${u.id}/activity.csv${q ? '?' + q : ''}">Download CSV</a></div>
    <div class="g3" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px"><label>Activity<select data-au="action">${actOpts(F.action)}</select></label>
      <label>From<input type="date" data-au="from" value="${esc(F.from)}"></label><label>To<input type="date" data-au="to" value="${esc(F.to)}"></label>
      <label>&nbsp;<button class="g2" data-act="aclear" style="margin-top:4px">Clear filters</button></label></div>
    ${logTable(AU.items, false, AU.cursor, 'user')}</div>
    <div class="card"><h2>Danger zone</h2><p class="meta">Permanently deletes every JD and resume stored for this user. Their activity history stays in the log. This cannot be undone.</p><button class="dng" data-act="awipe" data-id="${u.id}">Delete all data of this user</button>
    <hr style="border:0;border-top:1px solid var(--line);margin:18px 0"><p class="meta">Removes this email from the system entirely: the account, all their data <b>and their activity history</b>. They can only return by signing in again as a brand-new user. This cannot be undone.</p><button class="dng" data-act="adeluser" data-id="${u.id}">Delete user (${esc(u.email)})</button></div>`;
}

function drawNav() {
  const nm = ME?.name || ME?.email || '';
  $('#nav').innerHTML = `<a class="brand" href="/admin" data-home title="Go to dashboard">${LOGO}<span class="bt">CandidateMatch</span> <small>Admin</small></a>
  <div class="navlinks"><a data-nav="admin" class="${view !== 'ashort' ? 'on' : ''}">${ICON_DASH}Dashboard</a><a data-nav="ashort" class="${view === 'ashort' ? 'on' : ''}">${ICON_STAR}Shortlisted</a></div>
  <div class="userbox">${ME?.picture ? `<img src="${esc(ME.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="ph">${esc((nm[0] || '?').toUpperCase())}</span>`}<div><b>${esc(ME?.name || 'Admin')}</b><small>${esc(ME?.email || '')}</small></div><button class="g2" data-act="logout" title="Sign out">${ICON_OUT}</button></div>`;
}
function draw() { drawNav(); $('#main').innerHTML = view === 'adminuser' ? V_adminUser() : view === 'ashort' ? V_ashort() : V_admin(); }
async function go(v) {
  const changed = v !== view; view = v; M.err = '';
  if (changed) { drawNav(); $('#main').innerHTML = SKEL; }
  try {
    if (v === 'admin') await Promise.all([loadAdmin(), loadSS('a_log')]);
    else if (v === 'ashort') await Promise.all([AD.ov ? null : api('/overview').then(r => AD.ov = r), loadShort(), loadSS('a_short')]);
    else await loadAdminUser();
  } catch (e) { M.err = e.message; }
  if (view === v) draw();
}
const dlg = h => { $('#dlg').innerHTML = h + '<div class="row"><button onclick="document.getElementById(\'dlg\').close()">Close</button></div>'; $('#dlg').showModal(); };
async function reloadScope(scope) { if (scope === 'a_short') await loadShort(); else await loadAdminLog(true); }
const busy = async (msg, fn) => { M.busy = msg; M.err = ''; draw(); try { await fn(); } catch (e) { M.err = e.message; } M.busy = ''; draw(); };

document.addEventListener('click', async e => {
  const hm = e.target.closest('[data-home]');
  if (hm) { e.preventDefault(); hm.classList.remove('ping'); void hm.offsetWidth; hm.classList.add('ping'); return go('admin'); }
  const n = e.target.closest('[data-nav]'); if (n) return go(n.dataset.nav);
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act, id = +el.dataset.id;
  if (a === 'aview') {
    try {
      const c = AS.rows.find(x => x.id === id && x.analysis) || await api('/candidates/' + id);
      dlg(`<p class="meta" style="margin:0 0 12px">Shortlisted by <b>${esc(c.user?.name || c.user?.email || '—')}</b> on ${fmtD(c.shortlisted_at || c.created_at)} · ${c.jd_code}${c.jd?.client ? ' · ' + esc(c.jd.client) : ''}</p>`
        + CM.card({ ...c, label: c.name || c.label }, 0, { role: c.job_role, actions: fileBtns(c) }) + CM.LEG);
    } catch (x) { M.err = x.message; draw(); }
    return;
  }
  if (a === 'ssave') {
    const sc = el.dataset.scope, name = (prompt('Name this search', '') || '').trim(); if (!name) return;
    return busy('Saving…', async () => { await send('/searches', { scope: sc, name, query: SCOPES[sc]() }); await loadSS(sc, true); });
  }
  if (a === 'sapply') {
    const sc = el.dataset.scope, x = (SS[sc] || []).find(q => q.id === id); if (!x) return;
    Object.assign(SCOPES[sc](), SDEF[sc], x.query);
    return busy('Loading…', () => reloadScope(sc));
  }
  if (a === 'sclear') { const sc = el.dataset.scope; Object.assign(SCOPES[sc](), SDEF[sc]); return busy('Loading…', () => reloadScope(sc)); }
  if (a === 'sdel') {
    const sc = el.dataset.scope, x = (SS[sc] || []).find(q => q.id === id); if (!x || !confirm(`Delete saved search “${x.name}”?`)) return;
    return busy('Deleting…', async () => { await api('/searches/' + id, { method: 'DELETE' }); await loadSS(sc, true); });
  }
  if (a === 'logout') { await api('/auth/logout', { method: 'POST' }); location.href = '/admin'; return; }
  if (a === 'openuser') { AU = { id, profile: null, period: 'week', buckets: [], sel: null, items: [], cursor: null, f: { action: '', from: '', to: '' } }; return go('adminuser'); }
  if (a === 'aback') return go('admin');
  if (a === 'aper') return busy('Loading…', async () => { AU.period = el.dataset.p; AU.sel = null; await loadAUReport(); });
  if (a === 'abucket') return busy('Loading…', async () => { AU.sel = el.dataset.key; AU.f.from = el.dataset.from; AU.f.to = el.dataset.to; await loadAULog(true); });
  if (a === 'aclear') return busy('Loading…', async () => { AU.f = { action: '', from: '', to: '' }; AU.sel = null; await loadAULog(true); });
  if (a === 'amore') return busy('Loading…', () => el.dataset.scope === 'admin' ? loadAdminLog(false) : loadAULog(false));
  if (a === 'adeluser') {
    const u = AU.profile?.user; if (!u) return;
    if ((prompt(`This permanently deletes ${u.email}, ALL their data and their activity history.\nType their email to confirm.`) || '').trim().toLowerCase() !== u.email.toLowerCase()) return;
    return busy('Deleting user…', async () => { await send(`/users/${id}`, { confirm: u.email }, 'DELETE'); view = 'admin'; await loadAdmin(); });
  }
  if (a === 'awipe') {
    const u = AU.profile?.user; if (!u) return;
    if (prompt(`This permanently deletes ALL JDs and resumes of ${u.email}.\nType DELETE to confirm.`) !== 'DELETE') return;
    return busy('Deleting…', async () => { await send(`/users/${id}/wipe`, { confirm: 'DELETE' }); await loadAdminUser(); });
  }
});
document.addEventListener('input', e => {
  const t = e.target;
  if ('asearch' in t.dataset) { const v = t.value.trim().toLowerCase(); document.querySelectorAll('tr[data-q]').forEach(r => r.style.display = r.dataset.q.includes(v) ? '' : 'none'); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.af) { AD.f[t.dataset.af] = t.value; return busy('Loading…', () => loadAdminLog(true)); }
  if (t.dataset.au) { AU.f[t.dataset.au] = t.value; AU.sel = null; return busy('Loading…', () => loadAULog(true)); }
  if (t.dataset.sf) { AS.f[t.dataset.sf] = t.value; return busy('Loading…', loadShort); }
});
(async () => {
  try { ME = await api('/me'); } catch { return; }
  go('admin');
})();
