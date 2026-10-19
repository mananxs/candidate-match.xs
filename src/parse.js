import mammoth from 'mammoth';
import { ocrPdf } from './ai.js';

const clean = t => t.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** Turns any uploaded PDF / DOCX / TXT into plain text. Scanned PDFs fall back to Claude OCR. */
export async function fileToText(file) {
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  let text = '';
  if (ext === 'pdf') {
    try {
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      text = clean((await pdfParse(file.buffer)).text || '');
    } catch { text = ''; }
    if (text.length < 200) text = clean(await ocrPdf(file.buffer)); // scanned / image-only / odd encoding
  } else if (ext === 'docx') {
    text = clean((await mammoth.extractRawText({ buffer: file.buffer })).value);
  } else if (ext === 'txt') {
    text = clean(file.buffer.toString('utf8'));
  } else {
    throw new Error('Unsupported file type. Use PDF, DOCX or TXT.');
  }
  if (text.length < 60) throw new Error('No readable text found in this file.');
  return text;
}
