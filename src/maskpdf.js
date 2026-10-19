import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const safe = t => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u00A0/g, ' ')
  .replace(/[^\x09\x0A\x20-\x7E\xA1-\xFF\u2022\u2013\u2014\u20AC]/g, '?');

function wrap(t, font, size, maxW) {
  const out = [];
  for (const para of t.split('\n')) {
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

/** Renders the (editable) masked text into a clean ATS-style PDF, optionally watermarked with the XS logo. */
export async function buildPdf(text, { code, watermark, wmText, logo }) {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595, H = 842, M = 50, maxW = W - 2 * M;
  const ink = rgb(0.1, 0.1, 0.1), brand = rgb(0.12, 0.3, 0.23), grey = rgb(0.45, 0.45, 0.45);
  let page = doc.addPage([W, H]); const pages = [page]; let y = H - M;
  const ensure = h => { if (y - h < M + 24) { page = doc.addPage([W, H]); pages.push(page); y = H - M; } };
  const put = (t, o = {}) => {
    const { font = reg, size = 10, indent = 0, color = ink, gap = 3.5, bullet = false } = o;
    for (const [i, l] of wrap(t, font, size, maxW - indent - (bullet ? 12 : 0)).entries()) {
      ensure(size + gap);
      if (bullet && i === 0) page.drawText('\u2022', { x: M + indent, y: y - size, size, font });
      page.drawText(l, { x: M + indent + (bullet ? 12 : 0), y: y - size, size, font, color });
      y -= size + gap;
    }
  };

  put(code, { font: bold, size: 22, color: brand, gap: 6 });
  for (const raw of safe(text).split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { y -= 4; continue; }
    if (line.startsWith('@ ')) put(line.slice(2), { size: 12, color: grey, gap: 8 });
    else if (line.startsWith('# ')) {
      y -= 8; ensure(36);
      put(line.slice(2).toUpperCase(), { font: bold, size: 11, color: brand, gap: 3 });
      page.drawLine({ start: { x: M, y: y + 1 }, end: { x: W - M, y: y + 1 }, thickness: 0.6, color: rgb(0.75, 0.75, 0.7) });
      y -= 5;
    } else if (line.startsWith('## ')) { y -= 3; put(line.slice(3).replace(/\s*\|\s*/g, '  |  '), { font: bold, size: 10.5 }); }
    else if (/^\s*[-\u2022*] /.test(line)) put(line.replace(/^\s*[-\u2022*] /, ''), { bullet: true, indent: 8 });
    else put(line);
  }

  let img = null;
  if (watermark && logo) img = logo.type === 'image/png' ? await doc.embedPng(logo.buf) : await doc.embedJpg(logo.buf);
  const mark = (p, cx, cy, size, op) => { // default vector XS logo
    p.drawRectangle({ x: cx - size / 2, y: cy - size / 2, width: size, height: size, borderColor: brand, borderWidth: size / 14, borderOpacity: op });
    const fs = size * 0.58, tw = bold.widthOfTextAtSize('XS', fs);
    p.drawText('XS', { x: cx - tw / 2, y: cy - fs * 0.35, size: fs, font: bold, color: brand, opacity: op });
  };
  pages.forEach((p, i) => {
    if (watermark) {
      if (img) {
        const w = 280, h = w * img.height / img.width;
        p.drawImage(img, { x: W / 2 - w / 2, y: H / 2 - h / 2, width: w, height: h, opacity: 0.1 });
        const fh = 16; p.drawImage(img, { x: M, y: 22, width: fh * img.width / img.height, height: fh, opacity: 0.85 });
      } else {
        mark(p, W / 2, H / 2 + 10, 170, 0.1);
        if (wmText) { const s = 20, t = safe(wmText), tw = bold.widthOfTextAtSize(t, s); p.drawText(t, { x: W / 2 - tw / 2, y: H / 2 - 110, size: s, font: bold, color: brand, opacity: 0.12 }); }
        mark(p, M + 8, 30, 16, 0.85);
      }
    }
    const f = `Anonymized resume  \u00B7  ${code}${wmText && watermark ? '  \u00B7  ' + wmText : ''}  \u00B7  Page ${i + 1} of ${pages.length}`;
    p.drawText(safe(f), { x: M + (watermark ? 26 : 0), y: 26, size: 8, font: reg, color: grey });
  });
  return Buffer.from(await doc.save());
}
