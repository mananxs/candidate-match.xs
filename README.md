# CandidateMatch AI

AI resume ↔ JD matching, ranking and anonymization.
**Stack:** Node.js 20 · Express · Neon Postgres via **Prisma ORM** · pluggable AI (Gemini free tier by default; OpenAI-compatible or Claude optional) · pdf-lib (masked PDFs) · vanilla JS frontend (no build step).

## Quick start
1. **Neon** – create a project at https://neon.tech, open **Connect** and copy BOTH connection strings: pooled (`-pooler` in the host) and direct (no `-pooler`).
2. **Google sign-in** – Google Cloud Console → APIs & Services → Credentials → *Create OAuth client ID* → *Web application*. Add `http://localhost:3000` (and your production URL) under *Authorized JavaScript origins*. Copy the Client ID.
3. `cp .env.example .env` and fill in `DATABASE_URL`, `DIRECT_URL`, `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID` and `SESSION_SECRET` (a long random string).
4. `npm install` (also runs `prisma generate`)
5. `npx prisma db push` (or `npx prisma migrate dev --name accounts` if you use migrations) ← adds the `users` table and per-account ownership columns
6. `npm start` → http://localhost:3000 (landing page) → sign in → `/app`

**Accounts:** only verified `@gmail.com` Google accounts can sign in. Every account has its own JDs, candidates and settings. Rows created before accounts existed have no owner and are not shown to anyone.

7. **Admin portal** – add your Gmail to `ADMIN_EMAILS` in `.env` (comma-separated for several admins), restart, run `npx prisma db push` once (adds the `activity_logs` table) and, optionally, `npm run db:backfill-activity` to import your existing JDs / resumes into the history.

Production deploys: `npm install && npm run db:deploy` (applies committed migrations), then `npm start`.
Inspect data any time with `npm run db:studio`.

## What it does
- **Any format in:** PDF, DOCX, TXT. Text is extracted server-side; scanned/image PDFs automatically fall back to AI vision OCR (Gemini or Claude).
- **JD upload → auto-filled form:** title, experience, location, work mode (Remote / Hybrid / On-site dropdown), employment type (dropdown), budget, CTC, seniority, required / preferred skills, responsibilities, tools, education, certifications. Anything the JD doesn't state is highlighted amber – fill it in manually, then *Save requirements*.
- **Semantic matching:** every resume is scored against the JD's fixed skill list (Postgres = PostgreSQL, "built REST services in Flask" ⇒ Python + REST). Result: ATS % first, then Matched / Missing box.
  Colours (analysis only): matched+required **green**, matched+preferred **red**, rest **black**; missing preferred shows `(Preferred)` in front.
- **Ranking:** score (required ×3, preferred ×1.5, other ×0.6, partial = ½, experience-shortfall penalty up to −30%) → required skills covered → total matched.
- **Masking → PDF:** privacy settings drive the anonymization; preview the PDF, hand-edit the text / "remove everywhere" for anything missed, download with the XS watermark (default vector XS mark, or upload your own logo in Settings) or without.

## Admin portal (separate from the HR app)
Open **`/admin`** (e.g. http://localhost:3000/admin). It has its own sign-in page, its own session cookie (8 h) and its own API (`/admin-api`), and only Gmail addresses listed in `ADMIN_EMAILS` can sign in. An admin session cannot open the HR workspace (`/app`) and an HR session cannot open the admin portal. The HR site has no link to it.
- **Dashboard:** headline numbers, every user (click one to open them) and the **Activity Log** of all accounts, filterable by user, activity and dates.
- **User dashboard:** all-time totals (JDs uploaded, resumes analyzed / AI matched, masked, masking failed, PDFs downloaded, shortlisted, deleted, sign-ins), a **weekly (Mon–Sun) and monthly record with dates**, the full dated activity log (date / activity filters, **CSV download**), **Delete all data of this user**, and **Delete user** (removes the email, account, data and history entirely).
- The log stores metadata only (who, what, when, file name, score) – never resume text. It is a separate table, so history survives deleting JDs / resumes.
- Dates use `ADMIN_TZ` (default `Asia/Kolkata`). Code: `src/admin.js`, `public/admin.js`, `views/admin*.html`.

## Layout
```
prisma/schema.prisma  DB schema        src/server.js   REST API (Prisma queries)
src/db.js             Prisma client    src/ai.js       Claude prompts (JD extract, match, OCR, mask)
src/match.js          skill list + scoring   src/maskpdf.js  PDF generator + watermark
src/parse.js          file → text      src/auth.js     Google login + session cookie
public/index.html     landing page     views/app.html  signed-in workspace (public/app.js + style.css)
```

## Deploy
Any Node host (Render, Railway, Fly.io, a VPS): set the three env vars, build command `npm install`, start `npm start`, and run `npm run migrate` once.
Also set `NODE_ENV=production` and `SESSION_SECRET`, and add the production URL to the Google OAuth *Authorized JavaScript origins*.

## Notes
- Tune matching in `src/match.js` (weights) and `src/ai.js` (prompts). Model is `ANTHROPIC_MODEL`.
- Resume text is stored in Postgres so masking can be re-run; an admin can purge a user's data from the Admin Panel.

## Choosing the AI (`AI_PROVIDER` in `.env`)
| Provider | Cost | Notes |
|---|---|---|
| `gemini` (default) | Free tier | Reads scanned PDFs natively. Free-tier limits are low (about 15 requests/min); the app auto-retries on 429. Google may use free-tier data to improve its products, so avoid real candidate data on it. |
| `openai` | Groq / OpenRouter free models, or local Ollama | Set `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`. No scanned-PDF OCR. Ollama keeps everything on your machine. |
| `anthropic` | Paid | Best accuracy. Set `ANTHROPIC_API_KEY`. |
Small local models match skills noticeably worse than Gemini/Claude.
