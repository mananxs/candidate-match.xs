// One-time (safe to re-run): adds JDs and analyzed resumes that existed BEFORE the activity log
// to the Admin Panel history, using their original created_at dates. Masking / shortlist / download
// events from the past were never timestamped, so those only appear from now on.
//   npm run db:backfill-activity
import { prisma } from '../src/db.js';

const TITLES = /^(mr|mrs|ms|miss|mx|dr|prof|er)\.?$/i;
const pad = (p, id) => `${p}-${String(id).padStart(3, '0')}`;
const label = c => String(c.name || '').trim().split(/\s+/).find(w => w && !TITLES.test(w)) || pad('CAND', c.id);

const done = async action => new Set((await prisma.activityLog.findMany({ where: { action }, select: { entity_id: true } })).map(r => r.entity_id));
const [haveJd, haveRes] = [await done('jd_extracted'), await done('resume_analyzed')];

const jds = await prisma.jd.findMany({ where: { user_id: { not: null } }, select: { id: true, user_id: true, title: true, created_at: true } });
const cands = await prisma.candidate.findMany({ where: { user_id: { not: null } }, select: { id: true, user_id: true, jd_id: true, name: true, file_name: true, score: true, req_hit: true, req_total: true, created_at: true, jd: { select: { title: true } } } });

const data = [
  ...jds.filter(j => !haveJd.has(j.id)).map(j => ({ user_id: j.user_id, action: 'jd_extracted', entity: 'jd', entity_id: j.id, label: pad('JD', j.id), detail: { title: j.title, backfilled: true }, created_at: j.created_at })),
  ...cands.filter(c => !haveRes.has(c.id)).map(c => ({ user_id: c.user_id, action: 'resume_analyzed', entity: 'candidate', entity_id: c.id, label: label(c), detail: { file: c.file_name, jd_id: c.jd_id, jd_title: c.jd?.title, jd_code: pad('JD', c.jd_id), score: c.score, req_hit: c.req_hit, req_total: c.req_total, backfilled: true }, created_at: c.created_at })),
];
if (data.length) await prisma.activityLog.createMany({ data });
console.log(`Backfilled ${data.length} activity entries (${data.filter(d => d.entity === 'jd').length} JDs, ${data.filter(d => d.entity === 'candidate').length} resumes).`);
await prisma.$disconnect();
