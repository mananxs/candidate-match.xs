import { createHash } from 'node:crypto';
import { buildSkills } from './match.js';

/**
 * Pluggable LLM layer. Set AI_PROVIDER in .env:
 *   gemini    (default, FREE tier via Google AI Studio key)
 *   groq      (FREE tier via console.groq.com key; set GROQ_API_KEY or GROQ_API_KEYS=k1,k2)
 *   openai    (any OpenAI-compatible API: OpenRouter free models, Ollama local, OpenAI)
 *   anthropic (Claude)
 * If AI_PROVIDER is not set: uses gemini when a Gemini key exists, else groq when a Groq key exists.
 */
const splitKeys = v => (v || '').split(',').map(k => k.trim()).filter(Boolean);
const GEMINI_KEYS = splitKeys(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY);
const GROQ_KEYS = splitKeys(process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY);
const PROVIDER = (process.env.AI_PROVIDER || (!GEMINI_KEYS.length && GROQ_KEYS.length ? 'groq' : 'gemini')).toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

class AiHttpError extends Error {
  constructor(status, body, retryAfter = 0) { super(`AI request failed (${status}): ${body.slice(0, 300)}`); this.status = status; this.body = body; this.retryAfter = retryAfter; }
}

async function post(url, headers, body, { retry429 = true } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    const msg = await r.text();
    const retryable = (r.status === 429 && retry429) || r.status >= 500;
    if (retryable && attempt < 3) { await sleep(3000 * (attempt + 1)); continue; } // free-tier rate limits
    throw new AiHttpError(r.status, msg, Number(r.headers.get('retry-after')) || 0);
  }
}

/* ---- Key pools: GEMINI_API_KEYS=k1,k2 / GROQ_API_KEYS=k1,k2 (falls back to the single *_API_KEY) ----
   When a key hits its quota (429) it is parked for a while and the next key is used automatically. */
class KeyPool {
  constructor(name, keys, envVar) { this.name = name; this.keys = keys; this.envVar = envVar; this.parked = new Map(); this.next = 0; }
  pick(scope) {                                // round-robin over keys that are not parked for this model
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[(this.next + i) % this.keys.length];
      if ((this.parked.get(key + '|' + scope) || 0) <= now) { this.next = (this.next + i + 1) % this.keys.length; return key; }
    }
    return null;
  }
  earliestFree(scope) { return Math.min(...this.keys.map(k => this.parked.get(k + '|' + scope) || 0)); }
  // parkFor(error) -> ms to park the key for after a 429
  async post(url, headersFor, body, parkFor, scope = '', maxWait = 70000) {
    if (!this.keys.length) throw new Error(`${this.envVar} is not set`);
    for (let tries = 0; tries < this.keys.length * 2 + 2; tries++) {
      const key = this.pick(scope);
      if (!key) {                              // every key is parked: wait for the soonest one (up to maxWait)
        const wait = this.earliestFree(scope) - Date.now();
        if (wait > maxWait) break;
        await sleep(wait + 500);
        continue;
      }
      try {
        return await post(url, headersFor(key), body, { retry429: false });
      } catch (e) {
        if (e.status !== 429) throw e;
        this.parked.set(key + '|' + scope, Date.now() + parkFor(e));
        console.warn(`[ai] ${this.name} key #${this.keys.indexOf(key) + 1} of ${this.keys.length} hit its quota${scope ? ' on ' + scope : ''}`);
      }
    }
    const err = new Error(`All ${this.name} API keys have hit their quota${scope ? ' for ' + scope : ''}. Wait a few minutes (or until tomorrow if the daily limit is used up) or add another key.`);
    err.quota = true;
    throw err;
  }
}
const geminiPool = new KeyPool('Gemini', GEMINI_KEYS, 'GEMINI_API_KEY');
const groqPool = new KeyPool('Groq', GROQ_KEYS, 'GROQ_API_KEY');

// With several models in the chain we do NOT wait for a parked key: we move to the next model straight away.
const geminiPost = (url, body, scope, maxWait) => geminiPool.post(url, key => ({ 'x-goog-api-key': key }), body,
  e => /PerDay/i.test(e.body || '') ? 60 * 60 * 1000 : 65 * 1000, scope, maxWait);   // daily quota -> park longer than per-minute quota
// Groq tells us how long to wait via the retry-after header; a per-day limit parks the key for an hour.
const groqPost = (url, body, scope, maxWait) => groqPool.post(url, key => ({ Authorization: `Bearer ${key}` }), body,
  e => /per day|\bTPD\b|\bRPD\b/i.test(e.body || '') ? 60 * 60 * 1000 : Math.min(Math.max((e.retryAfter || 20) * 1000, 5000), 120000), scope, maxWait);

// Gemini 'thinking' adds many seconds per call. 0 = off (fast). Set GEMINI_THINKING_BUDGET=-1 for the model's default dynamic thinking.
let THINK_BUDGET = process.env.GEMINI_THINKING_BUDGET === undefined || process.env.GEMINI_THINKING_BUDGET === '' ? 0 : Number(process.env.GEMINI_THINKING_BUDGET);

// Models are tried in order; when one is out of quota the next one is used automatically.
// GEMINI_MODELS=a,b,c  (falls back to the single GEMINI_MODEL, then to the default chain below)
const GEMINI_MODELS = splitKeys(process.env.GEMINI_MODELS || process.env.GEMINI_MODEL).length
  ? splitKeys(process.env.GEMINI_MODELS || process.env.GEMINI_MODEL)
  : ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it'];
const GROQ_MODELS = splitKeys(process.env.GROQ_MODELS || process.env.GROQ_MODEL).length
  ? splitKeys(process.env.GROQ_MODELS || process.env.GROQ_MODEL)
  : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
const BAD_MODEL = e => e.status === 404 || (e.status === 400 && /not found|not supported|unsupported|invalid model|decommission/i.test(e.body || ''));
const noThink = new Set(), noJsonMode = new Set();      // models that rejected these settings (remembered)

async function geminiAsk(prompt, { max, json, pdf }) {
  const parts = [{ text: prompt }];
  if (pdf) parts.unshift({ inlineData: { mimeType: 'application/pdf', data: pdf.toString('base64') } });
  let lastErr;
  for (let mi = 0; mi < GEMINI_MODELS.length; mi++) {
    const model = GEMINI_MODELS[mi];
    const last = mi === GEMINI_MODELS.length - 1;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const body = () => {
      const cfg = { maxOutputTokens: Math.max(max, 8192), temperature: 0.1, ...(json && !noJsonMode.has(model) ? { responseMimeType: 'application/json' } : {}) };
      return { contents: [{ role: 'user', parts }], generationConfig: THINK_BUDGET === null || noThink.has(model) ? cfg : { ...cfg, thinkingConfig: { thinkingBudget: THINK_BUDGET } } };
    };
    try {
      let d;
      for (let fix = 0; ; fix++) {                // retry the same model once per unsupported setting
        try { d = await geminiPost(url, body(), model, last ? 70000 : 0); break; }
        catch (e) {
          if (e.status !== 400 || fix > 2) throw e;
          if (/think/i.test(e.body || '') && !noThink.has(model)) noThink.add(model);
          else if (/mime|json/i.test(e.body || '') && !noJsonMode.has(model)) noJsonMode.add(model);
          else throw e;
        }
      }
      const out = (d.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
      if (!out) throw new Error('Gemini returned an empty response' + (d.promptFeedback?.blockReason ? ` (blocked: ${d.promptFeedback.blockReason})` : ''));
      if (mi) console.log(`[ai] answered by ${model}`);
      return out;
    } catch (e) {
      lastErr = e;
      if (e.quota || BAD_MODEL(e)) { if (BAD_MODEL(e)) console.warn(`[ai] model "${model}" is not available - trying the next one`); else console.warn(`[ai] ${model} is out of quota - trying the next model`); continue; }
      throw e;
    }
  }
  const err = new Error('All Gemini models/keys have hit their quota (or are unavailable). Wait a few minutes, or until tomorrow if the daily limit is used up, or add another key / a Groq key. Last error: ' + (lastErr?.message || ''));
  err.quota = true;
  throw err;
}

async function groqAsk(prompt, { max, json, pdf }) {
  if (pdf) throw new Error('Scanned (image-only) PDFs need AI_PROVIDER=gemini or anthropic (Groq cannot read PDFs). Use a text-based PDF/DOCX instead.');
  const base = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  let lastErr;
  for (let mi = 0; mi < GROQ_MODELS.length; mi++) {
    const model = GROQ_MODELS[mi];
    const last = mi === GROQ_MODELS.length - 1;
    const body = { model, max_tokens: max, temperature: 0.1, messages: [{ role: 'user', content: prompt }], ...(json ? { response_format: { type: 'json_object' } } : {}) };
    try {
      const d = await groqPost(`${base}/chat/completions`, body, model, last ? 70000 : 0);
      const out = d.choices?.[0]?.message?.content || '';
      if (!out) throw new Error('Groq returned an empty response');
      return out;
    } catch (e) {
      lastErr = e;
      if (e.quota || BAD_MODEL(e)) { console.warn(`[ai] Groq model ${model} unavailable/out of quota - trying the next model`); continue; }
      throw e;
    }
  }
  const err = new Error('All Groq models/keys have hit their quota. Wait a few minutes or add another key. Last error: ' + (lastErr?.message || ''));
  err.quota = true;
  throw err;
}

// prompt: string. pdf: optional Buffer (scanned PDFs, native on gemini / anthropic only).
async function ask(prompt, { max = 4096, json = false, pdf = null } = {}) {
  if (PROVIDER === 'gemini') {
    try { return await geminiAsk(prompt, { max, json, pdf }); }
    catch (e) {                                   // every Gemini model/key is out of quota -> optional free Groq fallback
      if (e.quota && GROQ_KEYS.length && !pdf) {
        console.warn('[ai] Gemini quota used up on all models - falling back to Groq');
        return groqAsk(prompt, { max, json });
      }
      throw e;
    }
  }
  if (PROVIDER === 'groq') return groqAsk(prompt, { max, json, pdf });
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
  throw new Error(`Unknown AI_PROVIDER "${PROVIDER}". Use gemini, groq, openai or anthropic.`);
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

const JD_CACHE = new Map();

export async function extractJD(text) {
  const jk = createHash('sha1').update(text.slice(0, 20000)).digest('hex');
  if (JD_CACHE.has(jk)) return structuredClone(JD_CACHE.get(jk));
  const d = await askJson(`Extract structured requirements from this job description. It can be in ANY layout and may be noisy.
Return ONLY JSON with exactly these keys:
{"title":"","client":"","total_exp":null,"relevant_exp":null,"location":"","work_mode":"","employment_type":"","budget":"","current_ctc":"","expected_ctc":"","seniority":"","required_skills":[],"preferred_skills":[],"hands_on_skills":[],"responsibilities":[],"technologies":[],"education":[],"certifications":[]}
Rules:
- Use "" / null / [] when a detail is NOT stated. Never guess or invent.
- total_exp = overall years required (number). relevant_exp = years required in the core skill/domain, ONLY if stated separately, else null.
- work_mode must be one of ${ENUMS.work_mode.join(' | ')} or "". employment_type must be one of ${ENUMS.employment_type.join(' | ')} or "".
- seniority e.g. Intern, Junior, Mid, Senior, Lead, Manager, Director.
- required_skills = must-have / mandatory / core skills (short names, not sentences). preferred_skills = nice-to-have / plus / bonus. If the JD does not distinguish, put the central skills in required_skills.
- hands_on_skills = ONLY the skills for which the JD explicitly asks for hands-on / practical / working / proven experience (e.g. "hands-on experience with Kubernetes", "must have worked on AWS"). Use exactly the same short names you used in required_skills / preferred_skills / technologies. [] if the JD never says so.
- technologies = concrete tools/platforms/languages mentioned that are not already listed above.
- responsibilities = short bullet strings. education = degrees/qualifications only. certifications = certifications only.

JD:
${text.slice(0, 20000)}`);
  for (const k of Object.keys(ENUMS)) {
    d[k] = ENUMS[k].find(v => v.toLowerCase() === String(d[k] || '').toLowerCase()) || '';
  }
  d.hands_on = Array.isArray(d.hands_on_skills) ? d.hands_on_skills : [];
  delete d.hands_on_skills;
  if (JD_CACHE.size >= 100) JD_CACHE.delete(JD_CACHE.keys().next().value);
  JD_CACHE.set(jk, structuredClone(d));
  return d;
}

// Same resume + same JD skills -> same answer, so re-runs are instant (small in-memory cache).
const ANALYSIS_CACHE = new Map();
const CACHE_MAX = 300;

export async function analyzeResume(jd, text) {
  const skills = buildSkills(jd);
  const ck = createHash('sha1').update(JSON.stringify(skills)).update('\n').update(text.slice(0, 20000)).digest('hex');
  if (ANALYSIS_CACHE.has(ck)) return structuredClone(ANALYSIS_CACHE.get(ck));
  const d = await askJson(`You are an expert recruiter / ATS engine. Compare ONE resume against a FIXED list of JD skills.
The resume text was machine-extracted from a file of arbitrary layout: ignore formatting noise, broken columns, headers and footers.
For EACH skill decide a status using SEMANTIC understanding, not keyword matching:
"matched" = shown directly, via a synonym/abbreviation (Postgres = PostgreSQL, K8s = Kubernetes), or via clearly equivalent hands-on work (e.g. "built REST services in Flask" evidences Python and REST APIs).
"partial" = only an adjacent / weaker substitute (e.g. MySQL when PostgreSQL is required).
"missing" = no real evidence.
evidence = max 14 words, paraphrased from the resume (empty for missing).
Skills marked [HANDS-ON] must be backed by practical use: for those add "h":true when the resume shows real hands-on work with it (built, deployed, administered, used in a project or job), "h":false when it is only listed / mentioned.
Also return the candidate's full name, total years of RELEVANT experience (number or null) and a one-sentence fit summary.
Return ONLY JSON: {"candidate":"","candidate_years":null,"summary":"","skills":[{"i":0,"status":"matched|partial","evidence":"","h":true}]}
IMPORTANT: list ONLY the skills that are "matched" or "partial", each referenced by its number "i". Do NOT list missing skills - every skill you leave out is treated as missing.

JD SKILLS (number. name):
${skills.map((s, i) => `${i}. ${s.name}${s.hands_on ? ' [HANDS-ON]' : ''}`).join('\n')}

RESUME:
${text.slice(0, 20000)}`);
  const byIdx = new Map(), by = new Map();                 // model answers by number (fallback: by name)
  (Array.isArray(d.skills) ? d.skills : []).forEach(s => { if (Number.isInteger(+s?.i) && s.i !== '' && s.i !== null) byIdx.set(+s.i, s); if (s?.name) by.set(String(s.name).toLowerCase(), s); });
  d.skills = skills.map((s, idx) => {
    const r = byIdx.get(idx) || by.get(s.name.toLowerCase());
    const status = ['matched', 'partial', 'missing'].includes(r?.status) ? r.status : 'missing';
    return { name: s.name, type: s.type, status, evidence: r?.evidence || '', ...(s.hands_on ? { hands_on: true, hands_on_shown: status !== 'missing' && r?.h !== false } : {}) };
  });
  if (ANALYSIS_CACHE.size >= CACHE_MAX) ANALYSIS_CACHE.delete(ANALYSIS_CACHE.keys().next().value);
  ANALYSIS_CACHE.set(ck, structuredClone(d));
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
