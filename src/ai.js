import { buildSkills } from './match.js';

/**
 * Pluggable LLM layer. Set AI_PROVIDER in .env:
 *   gemini    (default, FREE tier via Google AI Studio key)
 *   openai    (any OpenAI-compatible API: Groq / OpenRouter free models, Ollama local, OpenAI)
 *   anthropic (Claude)
 */
const PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

class AiHttpError extends Error {
  constructor(status, body) { super(`AI request failed (${status}): ${body.slice(0, 300)}`); this.status = status; this.body = body; }
}

async function post(url, headers, body, { retry429 = true } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    const msg = await r.text();
    const retryable = (r.status === 429 && retry429) || r.status >= 500;
    if (retryable && attempt < 3) { await sleep(6000 * (attempt + 1)); continue; } // free-tier rate limits
    throw new AiHttpError(r.status, msg);
  }
}

/* ---- Gemini key pool: GEMINI_API_KEYS=key1,key2,key3 (falls back to GEMINI_API_KEY) ----
   When a key hits its quota (429) it is parked for a while and the next key is used automatically. */
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const parkedUntil = new Map();   // key -> time (ms) when it may be used again
let nextKey = 0;

function pickKey() {             // round-robin over keys that are not parked
  const now = Date.now();
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = GEMINI_KEYS[(nextKey + i) % GEMINI_KEYS.length];
    if ((parkedUntil.get(key) || 0) <= now) { nextKey = (nextKey + i + 1) % GEMINI_KEYS.length; return key; }
  }
  return null;
}
const earliestFree = () => Math.min(...GEMINI_KEYS.map(k => parkedUntil.get(k) || 0));

async function geminiPost(url, body) {
  if (!GEMINI_KEYS.length) throw new Error('GEMINI_API_KEY is not set');
  for (let tries = 0; tries < GEMINI_KEYS.length * 2 + 2; tries++) {
    const key = pickKey();
    if (!key) {                                  // every key is parked: wait for the soonest one (max ~70 s)
      const wait = earliestFree() - Date.now();
      if (wait > 70000) break;
      await sleep(wait + 500);
      continue;
    }
    try {
      return await post(url, { 'x-goog-api-key': key }, body, { retry429: false });
    } catch (e) {
      if (e.status !== 429) throw e;
      const daily = /PerDay/i.test(e.body || '');            // daily quota -> park longer than per-minute quota
      parkedUntil.set(key, Date.now() + (daily ? 60 * 60 * 1000 : 65 * 1000));
      console.warn(`[ai] Gemini key #${GEMINI_KEYS.indexOf(key) + 1} of ${GEMINI_KEYS.length} hit its ${daily ? 'daily' : 'per-minute'} quota - switching key`);
    }
  }
  throw new Error('All Gemini API keys have hit their quota. Wait a few minutes (or until tomorrow if the daily limit is used up) or add another key.');
}

// prompt: string. pdf: optional Buffer (scanned PDFs, native on gemini / anthropic only).
async function ask(prompt, { max = 4096, json = false, pdf = null } = {}) {
  if (PROVIDER === 'gemini') {
    const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
    const parts = [{ text: prompt }];
    if (pdf) parts.unshift({ inlineData: { mimeType: 'application/pdf', data: pdf.toString('base64') } });
    const d = await geminiPost(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: Math.max(max, 8192), temperature: 0.1, ...(json ? { responseMimeType: 'application/json' } : {}) } });
    const out = (d.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    if (!out) throw new Error('Gemini returned an empty response' + (d.promptFeedback?.blockReason ? ` (blocked: ${d.promptFeedback.blockReason})` : ''));
    return out;
  }
  if (PROVIDER === 'openai') {
    if (pdf) throw new Error('Scanned (image-only) PDFs need AI_PROVIDER=gemini or anthropic. Use a text-based PDF/DOCX instead.');
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const d = await post(`${base}/chat/completions`, { Authorization: `Bearer ${process.env.OPENAI_API_KEY || 'none'}` },
      { model: process.env.OPENAI_MODEL, max_tokens: max, temperature: 0.1, messages: [{ role: 'user', content: prompt }] });
    return d.choices?.[0]?.message?.content || '';
  }
  if (PROVIDER === 'anthropic') {
    const content = [{ type: 'text', text: prompt }];
    if (pdf) content.unshift({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } });
    const d = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: max, messages: [{ role: 'user', content }] });
    return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  throw new Error(`Unknown AI_PROVIDER "${PROVIDER}". Use gemini, openai or anthropic.`);
}
const parseJson = t => {
  const s = t.replace(/```json|```/g, '');
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
};
async function askJson(prompt, max) {
  for (let i = 0; i < 2; i++) {
    const t = await ask(prompt, { max, json: true });
    try { return parseJson(t); } catch { if (i) throw new Error('AI returned an unreadable response, please retry'); }
  }
}

/** OCR for scanned PDFs: the model reads the PDF natively (gemini / anthropic). */
export async function ocrPdf(buffer) {
  return ask('Transcribe ALL text in this document in natural reading order (handle multi-column layouts). Output only the text.', { max: 8000, pdf: buffer });
}

export const ENUMS = {
  work_mode: ['Remote', 'Hybrid', 'On-site'],
  employment_type: ['Full-time', 'Part-time', 'Contract', 'Contract-to-hire', 'Internship', 'Freelance'],
};

export async function extractJD(text) {
  const d = await askJson(`Extract structured requirements from this job description. It can be in ANY layout and may be noisy.
Return ONLY JSON with exactly these keys:
{"title":"","client":"","total_exp":null,"relevant_exp":null,"location":"","work_mode":"","employment_type":"","budget":"","current_ctc":"","expected_ctc":"","seniority":"","required_skills":[],"preferred_skills":[],"responsibilities":[],"technologies":[],"education":[],"certifications":[]}
Rules:
- Use "" / null / [] when a detail is NOT stated. Never guess or invent.
- total_exp = overall years required (number). relevant_exp = years required in the core skill/domain, ONLY if stated separately, else null.
- work_mode must be one of ${ENUMS.work_mode.join(' | ')} or "". employment_type must be one of ${ENUMS.employment_type.join(' | ')} or "".
- seniority e.g. Intern, Junior, Mid, Senior, Lead, Manager, Director.
- required_skills = must-have / mandatory / core skills (short names, not sentences). preferred_skills = nice-to-have / plus / bonus. If the JD does not distinguish, put the central skills in required_skills.
- technologies = concrete tools/platforms/languages mentioned that are not already listed above.
- responsibilities = short bullet strings. education = degrees/qualifications only. certifications = certifications only.

JD:
${text.slice(0, 20000)}`);
  for (const k of Object.keys(ENUMS)) {
    d[k] = ENUMS[k].find(v => v.toLowerCase() === String(d[k] || '').toLowerCase()) || '';
  }
  return d;
}

export async function analyzeResume(jd, text) {
  const skills = buildSkills(jd);
  const d = await askJson(`You are an expert recruiter / ATS engine. Compare ONE resume against a FIXED list of JD skills.
The resume text was machine-extracted from a file of arbitrary layout: ignore formatting noise, broken columns, headers and footers.
For EACH skill decide a status using SEMANTIC understanding, not keyword matching:
"matched" = shown directly, via a synonym/abbreviation (Postgres = PostgreSQL, K8s = Kubernetes), or via clearly equivalent hands-on work (e.g. "built REST services in Flask" evidences Python and REST APIs).
"partial" = only an adjacent / weaker substitute (e.g. MySQL when PostgreSQL is required).
"missing" = no real evidence.
evidence = max 14 words, paraphrased from the resume (empty for missing).
Also return the candidate's full name, total years of RELEVANT experience (number or null) and a one-sentence fit summary.
Return ONLY JSON: {"candidate":"","candidate_years":null,"summary":"","skills":[{"name":"","status":"matched|partial|missing","evidence":""}]}
Keep skill names exactly as given.

JD SKILLS:
${JSON.stringify(skills.map(s => s.name))}

RESUME:
${text.slice(0, 20000)}`);
  const by = new Map((d.skills || []).map(s => [String(s.name).toLowerCase(), s]));
  d.skills = skills.map(s => {
    const r = by.get(s.name.toLowerCase());
    return { name: s.name, type: s.type, status: ['matched', 'partial', 'missing'].includes(r?.status) ? r.status : 'missing', evidence: r?.evidence || '' };
  });
  return d;
}

const HIDE_LABELS = {
  surname: 'surname (use first name initial only, or omit the name entirely)', address: 'address', email: 'email', phone: 'phone number',
  linkedin: 'LinkedIn', github: 'GitHub', social: 'social media handles', sites: 'personal websites',
  dates: 'exact employment dates (use durations like "2 yrs")',
  employer: 'employer names (use generic descriptors like "Large fintech company")', photos: 'photos',
  latest: 'the latest/current employer name (generalize it)',
};

export async function maskResume(text, code, hide) {
  const list = Object.keys(hide).filter(k => hide[k]).map(k => HIDE_LABELS[k]).filter(Boolean).join('; ');
  return (await ask(`Rewrite this resume as an anonymized, standard single-layout ATS resume.
REMOVE or generalize: ${list || 'nothing'}. Also remove the candidate's real name entirely (the identifier is ${code}).
Keep ALL skills, achievements, responsibilities, certifications, education (degree + field) and durations.
OUTPUT FORMAT (plain text, no markdown fences, nothing else):
@ <professional headline>
# SUMMARY
paragraph
# SKILLS
- skill group: items
# EXPERIENCE
## Job title | Company descriptor | Duration
- bullet
# EDUCATION
- item
# CERTIFICATIONS
- item

RESUME:
${text.slice(0, 20000)}`, { max: 6000 })).replace(/```/g, '').trim();
}
