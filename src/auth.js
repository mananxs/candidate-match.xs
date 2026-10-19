// Google sign-in (Gmail only) + signed session cookie. No extra session store needed.
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { isAdminEmail } from './activity.js';

const isProd = process.env.NODE_ENV === 'production';
const SECRET = process.env.SESSION_SECRET || (isProd ? '' : crypto.randomBytes(32).toString('hex'));
if (!SECRET) throw new Error('SESSION_SECRET is required when NODE_ENV=production');
if (!process.env.SESSION_SECRET) console.warn('[auth] SESSION_SECRET not set - using a temporary one, everyone is logged out on restart.');

const COOKIE = 'cm_session';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const fail = (msg, status = 401) => Object.assign(new Error(msg), { status });

const sign = body => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');

function makeToken(payload, maxAge = MAX_AGE) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + maxAge })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readToken(req, cookieName) {
  const part = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(cookieName + '='));
  if (!part) return null;
  const [body, sig] = decodeURIComponent(part.slice(cookieName.length + 1)).split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

/** Returns { uid } when the request carries a valid, unexpired HR session cookie, otherwise null. */
export function readSession(req) {
  const d = readToken(req, COOKIE);
  return d && !d.role ? d : null;          // an admin token can never act as an HR session
}

export const startSession = (res, userId) =>
  res.cookie(COOKIE, makeToken({ uid: userId }), { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: MAX_AGE, path: '/' });
export const endSession = res => res.clearCookie(COOKIE, { path: '/' });

/** Protects every /api route that is mounted after it. Sets req.user = { id }. */
export function requireAuth(req, res, next) {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'Please sign in.' });
  req.user = { id: s.uid };
  next();
}

/* ---------- Admin portal session (separate cookie, separate role - never valid for the HR app) ---------- */
const ADMIN_COOKIE = 'cm_admin';
const ADMIN_MAX_AGE = 8 * 60 * 60 * 1000; // 8 hours
export function readAdminSession(req) {
  const d = readToken(req, ADMIN_COOKIE);
  return d?.role === 'admin' && isAdminEmail(d.email) ? d : null;   // re-checks ADMIN_EMAILS on every request
}
export const startAdminSession = (res, g) =>
  res.cookie(ADMIN_COOKIE, makeToken({ role: 'admin', email: g.email, name: g.name, picture: g.picture }, ADMIN_MAX_AGE), { httpOnly: true, sameSite: 'strict', secure: isProd, maxAge: ADMIN_MAX_AGE, path: '/' });
export const endAdminSession = res => res.clearCookie(ADMIN_COOKIE, { path: '/' });
export function requireAdminAuth(req, res, next) {
  const s = readAdminSession(req);
  if (!s) return res.status(401).json({ error: 'Please sign in as admin.' });
  req.admin = { email: s.email, name: s.name, picture: s.picture };
  next();
}

const client = new OAuth2Client();

/** Verifies the Google ID token and allows verified @gmail.com accounts only. */
export async function verifyGmail(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw fail('Google sign-in is not configured (GOOGLE_CLIENT_ID missing).', 500);
  if (!credential) throw fail('Missing Google credential.', 400);
  let p;
  try {
    p = (await client.verifyIdToken({ idToken: credential, audience: clientId })).getPayload();
  } catch { throw fail('Google sign-in could not be verified. Please try again.'); }
  if (!p?.email_verified) throw fail('Your Google email is not verified.', 403);
  if (!/@gmail\.com$/i.test(p.email || '')) throw fail('Only Gmail accounts (@gmail.com) can sign in.', 403);
  return { google_id: p.sub, email: p.email.toLowerCase(), name: p.name || null, picture: p.picture || null };
}
