// Landing page: Google sign-in (Gmail only) + small animations.
const $ = s => document.querySelector(s);
const msg = $('#authMsg');
const say = (t, bad) => { msg.textContent = t; msg.classList.toggle('bad', !!bad); };
$('#yr').textContent = new Date().getFullYear();

// Animated score numbers + bars
document.querySelectorAll('.score').forEach(el => {
  const to = +el.dataset.n, t0 = performance.now() + 1900;
  const tick = now => {
    const p = Math.min(Math.max((now - t0) / 1200, 0), 1);
    el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))) + '%';
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

async function onCredential(resp) {
  say('Signing you in…');
  try {
    const r = await fetch('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: resp.credential }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Sign-in failed');
    location.href = '/app';
  } catch (e) { say(e.message, true); }
}

function initGoogle(clientId) {
  if (!window.google?.accounts?.id) return setTimeout(() => initGoogle(clientId), 150);
  google.accounts.id.initialize({ client_id: clientId, callback: onCredential, ux_mode: 'popup' });
  ['#gHero', '#gBottom'].forEach(s => google.accounts.id.renderButton($(s), { theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'continue_with', logo_alignment: 'left', width: 280 }));
}

(async () => {
  // Already signed in? Offer a direct link to the dashboard.
  const me = await fetch('/api/me').then(r => r.ok ? r.json() : null).catch(() => null);
  if (me) {
    $('#openApp').hidden = false; $('#gHero').hidden = true; $('#gBottom').hidden = true;
    $('#navCta').textContent = 'Open dashboard'; $('#navCta').href = '/app';
    say(`Signed in as ${me.email}`);
    return;
  }
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  if (!cfg.googleClientId) return say('Google sign-in is not configured yet. Set GOOGLE_CLIENT_ID in .env.', true);
  initGoogle(cfg.googleClientId);
})();
