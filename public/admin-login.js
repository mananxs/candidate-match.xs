// Admin sign-in: Google (Gmail) -> /admin-api/auth/google. Only ADMIN_EMAILS are accepted; this never signs anyone into the HR app.
const $ = s => document.querySelector(s);
const say = (t, bad) => { $('#msg').textContent = t; $('#msg').classList.toggle('bad', !!bad); };

async function onCredential(resp) {
  say('Signing you in…');
  try {
    const r = await fetch('/admin-api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: resp.credential }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Sign-in failed');
    location.href = '/admin';
  } catch (e) { say(e.message, true); }
}
function initGoogle(clientId) {
  if (!window.google?.accounts?.id) return setTimeout(() => initGoogle(clientId), 150);
  google.accounts.id.initialize({ client_id: clientId, callback: onCredential, ux_mode: 'popup' });
  google.accounts.id.renderButton($('#g'), { theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'signin_with', width: 280 });
}
(async () => {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  if (!cfg.googleClientId) return say('Google sign-in is not configured (GOOGLE_CLIENT_ID).', true);
  initGoogle(cfg.googleClientId);
})();
