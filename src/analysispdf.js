// One-page-ish "match analysis" PDF (score, skills matched / missing, experience, summary).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const safe = t => String(t ?? '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u00A0/g, ' ')
  .replace(/[^\x09\x0A\x20-\x7E\xA1-\xFF\u2022\u2013\u2014\u20AC]/g, '?');

function wrap(t, font, size, maxW) {
  const out = [];
  for (const para of safe(t).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      const test = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) <= maxW) line = test;
      else { if (line) out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

/** c = { label, file_name, score, req_hit, req_total, analysis }, role = job title */
export async function buildAnalysisPdf(c, role) {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595, H = 842, M = 48, maxW = W - 2 * M;
  const ink = rgb(0.1, 0.1, 0.1), brand = rgb(0.12, 0.3, 0.23), grey = rgb(0.45, 0.45, 0.45), red = rgb(0.7, 0.15, 0.15);
  let page = doc.addPage([W, H]), y = H - M;
  const ensure = h => { if (y - h < M) { page = doc.addPage([W, H]); y = H - M; } };
  const put = (t, { font = reg, size = 10, color = ink, indent = 0, gap = 3 } = {}) => {
    for (const l of wrap(t, font, size, maxW - indent)) { ensure(size + gap); page.drawText(l, { x: M + indent, y: y - size, size, font, color }); y -= size + gap; }
  };
  const a = c.analysis || {};
  put('Match analysis', { font: bold, size: 18, color: brand, gap: 6 });
  put(`${c.label}  -  ${role || 'Role'}`, { font: bold, size: 12, gap: 4 });
  put(`File: ${c.file_name || '-'}`, { color: grey, gap: 8 });
  put(`ATS score: ${c.score ?? 0}%     Required skills covered: ${Math.round((c.req_hit || 0) * 10) / 10} / ${c.req_total || 0}`, { font: bold, size: 11, gap: 6 });
  const req = a.required_years, cy = a.candidate_years;
  put(`Required experience: ${req ?? '-'} yrs     Candidate experience: ${cy ?? 'not stated'} yrs`, { gap: 10 });
  if (a.summary) { put('Summary', { font: bold, size: 11, color: brand }); put(a.summary, { gap: 10 }); }
  const sk = a.skills || [], label = { matched: 'MATCHED', partial: 'PARTIAL', missing: 'MISSING' };
  for (const st of ['matched', 'partial', 'missing']) {
    const list = sk.filter(s => s.status === st);
    if (!list.length) continue;
    ensure(30); put(`${label[st]} (${list.length})`, { font: bold, size: 11, color: st === 'missing' ? red : brand, gap: 4 });
    for (const s of list) {
      put(`- ${s.name} [${s.type}]${s.hands_on ? (s.status === 'missing' ? ' - hands-on required' : s.hands_on_shown ? ' - hands-on shown' : ' - hands-on not shown') : ''}`, { indent: 6, gap: 2 });
      if (s.evidence) put(s.evidence, { indent: 18, size: 9, color: grey, gap: 2 });
    }
    y -= 6;
  }
  return Buffer.from(await doc.save());
}
