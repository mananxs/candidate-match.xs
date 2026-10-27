// Saved searches: named filter sets for a panel (Candidates, Talent search, Admin Shortlisted ...), reusable when a similar JD arrives.
// The same router serves HR (owner = { user_id }) and admins (owner = { admin_email }).
import express from 'express';
import { prisma } from './db.js';

const SCOPE = /^[a-z_]{2,20}$/;
const SEL = { id: true, scope: true, name: true, query: true, created_at: true };

export function searchRouter(h, bad, ownerOf) {
  const r = express.Router();
  r.get('/', h(async (req, res) => {
    const scope = SCOPE.test(req.query.scope || '') ? req.query.scope : undefined;
    res.json(await prisma.savedSearch.findMany({ where: { ...ownerOf(req), ...(scope ? { scope } : {}) }, select: SEL, orderBy: { id: 'desc' }, take: 200 }));
  }));
  r.post('/', h(async (req, res) => {
    const { scope, name, query } = req.body || {};
    if (!SCOPE.test(scope || '')) throw bad('Invalid panel.');
    const nm = String(name || '').trim().slice(0, 80);
    if (!nm) throw bad('Give the search a name.');
    const q = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
    if (JSON.stringify(q).length > 4000) throw bad('Search is too large to save.');
    const owner = ownerOf(req);
    const same = await prisma.savedSearch.findFirst({ where: { ...owner, scope, name: nm }, select: { id: true } });   // same name = overwrite
    res.json(same
      ? await prisma.savedSearch.update({ where: { id: same.id }, data: { query: q }, select: SEL })
      : await prisma.savedSearch.create({ data: { ...owner, scope, name: nm, query: q }, select: SEL }));
  }));
  r.delete('/:id', h(async (req, res) => {
    await prisma.savedSearch.deleteMany({ where: { id: Number(req.params.id) || 0, ...ownerOf(req) } });
    res.json({ ok: true });
  }));
  return r;
}
