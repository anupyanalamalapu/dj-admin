# DJ Admin Standalone

Standalone internal admin tool for managing DJ client context, workspaces, contracts, invoices, and profile memory.

This is an extracted copy of the admin system from the main DJ website repo, packaged to run independently.

## Purpose

- Intake new client context from pasted text or uploaded files
- Route context to an existing workspace or create a new one
- Maintain workspace/profile metadata and communication history
- Generate stage-aware draft responses
- Generate/edit contract dynamic fields using fixed legal boilerplate
- Track checklist actions (signed contract, deposit proof, etc.)
- Persist all MVP data locally under `data/admin`

## Tech Stack

- Next.js 14 (App Router)
- React 18 + TypeScript
- Tailwind CSS
- Local JSON/files + Postgres auth storage (SQLite fallback for local dev)

## Quick Start

1. Install dependencies

```bash
npm install
```

2. Create env file

```bash
cp .env.example .env.local
```

Or copy the prefilled local template:

```bash
cp .env.local.example .env.local
```

3. Run app

```bash
npm run dev
```

4. Open

`http://localhost:3000/admin/login`

## Login (Safe Bootstrap Flow)

This app no longer relies on static plaintext env credentials for normal login.

First run:

1. Set `ADMIN_BOOTSTRAP_TOKEN` and `ADMIN_SESSION_SECRET` in `.env.local`
2. Start app and open `/admin/login`
3. Bootstrap once from a trusted terminal (do not type bootstrap token in browser UI):

```bash
curl -X POST "http://localhost:3000/api/admin/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -H "x-admin-bootstrap-token: $ADMIN_BOOTSTRAP_TOKEN" \
  -d '{"username":"admin","password":"StrongPass!123"}'
```

After bootstrap:

- Password is stored as a **scrypt hash** in auth storage (Postgres in deploy environments)
- Sessions are server-side persisted and cookie-backed
- Login route is rate-limited with temporary lockout and `retryAfter`
- Session rotation is enforced on successful login (old sessions are revoked)

## `.env.local` Setup (Recommended)

Use this baseline:

```env
ADMIN_BOOTSTRAP_TOKEN=replace-with-random-bootstrap-token
ADMIN_SESSION_SECRET=replace-with-random-session-secret
ADMIN_DATA_DIR=./data/admin
DATABASE_URL=

ADMIN_ENABLE_CODEX_AI=true
OPENAI_API_KEY=sk-your-key-here

ADMIN_CODEX_MODEL_EXTRACT=gpt-4.1-mini
ADMIN_CODEX_MODEL_MATCH=gpt-4.1-mini
ADMIN_CODEX_MODEL_EMAIL=gpt-4.1
ADMIN_CODEX_MODEL_AMENDMENT=gpt-4.1
ADMIN_CODEX_MODEL_SUMMARY=gpt-4.1-mini

ADMIN_ENABLE_AI_OCR=true
ADMIN_CODEX_MODEL_OCR=gpt-4.1-mini
ADMIN_ENABLE_LOCATION_API=false
```

Notes:

- `ADMIN_BOOTSTRAP_TOKEN` is required for first admin creation.
- `ADMIN_SESSION_SECRET` is required and must be at least 32 characters.
- `OPENAI_API_KEY` is required for AI extraction/matching/drafting/OCR.
- If `ADMIN_ENABLE_CODEX_AI=false`, the app falls back to local heuristics.
- If `ADMIN_ENABLE_AI_OCR=true`, `OPENAI_API_KEY` is required.

## Data Storage

By default, runtime data is stored in:

- `data/admin/store/admin-store.json` (workspace/client/event state)
- Auth tables in Postgres when `DATABASE_URL`/`POSTGRES_URL` is set
- `data/admin/store/auth.db` fallback only when Postgres env vars are absent (local dev)
- `data/admin/uploads/` (uploaded files)
- `data/admin/contracts/` (generated contracts/artifacts)
- `data/admin/clients/client_{id}.md` (client memory markdown)

You can override root with `ADMIN_DATA_DIR`.

Repository safety:

- Do not commit runtime files under `data/admin/store/*`.
- Keep only `data/admin/store/.gitkeep` in git.

## Auth Migration (Legacy JSON -> DB)

On first auth access, the app performs an idempotent startup migration:

- Reads legacy `data/admin/store/admin-auth.json` if present
- Backs it up to `data/admin/store/admin-auth.json.backup-<timestamp>.json`
- Migrates users, sessions, and rate-limit records into the active auth backend
- Marks migration complete so repeated startups do not re-import

If legacy JSON does not exist, startup initializes auth schema only.

## AI / OCR Configuration

Base local heuristics work without OpenAI.

To enable Codex/OpenAI services:

- set `OPENAI_API_KEY`
- set `ADMIN_ENABLE_CODEX_AI=true`

To enable AI OCR for uploads:

- set `ADMIN_ENABLE_AI_OCR=true`

Optional per-service model controls:

- `ADMIN_CODEX_MODEL_EXTRACT`
- `ADMIN_CODEX_MODEL_MATCH`
- `ADMIN_CODEX_MODEL_EMAIL`
- `ADMIN_CODEX_MODEL_AMENDMENT`
- `ADMIN_CODEX_MODEL_SUMMARY`
- `ADMIN_CODEX_MODEL_OCR`

Runtime diagnostics for admins:

- `GET /api/admin/config/health`
- Returns booleans/status only (no secrets), including bootstrap state, secret/key presence, and model config status.

## Secrets and Rotation

Local/dev:

- Keep `.env.local` out of git.
- Use long random values for `ADMIN_BOOTSTRAP_TOKEN` and `ADMIN_SESSION_SECRET`.

Production:

- Store `ADMIN_BOOTSTRAP_TOKEN`, `ADMIN_SESSION_SECRET`, and `OPENAI_API_KEY` in a secret manager (not in source files).
- Inject secrets at runtime via environment variables.

Rotation guidance:

- Rotating `ADMIN_SESSION_SECRET` invalidates existing sessions immediately; users must log in again.
- Rotating `ADMIN_BOOTSTRAP_TOKEN` affects only first-admin bootstrap flow.

Recovery:

- If bootstrap token is lost and no admin exists yet, set a new `ADMIN_BOOTSTRAP_TOKEN` and bootstrap again.
- If an admin already exists, bootstrap endpoint is intentionally disabled; use existing admin credentials and reset via DB/admin tooling if needed.

## Admin Test Suite

```bash
npm run test:admin
```

## Sample Contexts for Demo

Paste these into `/admin/inquiry`:

### 1) New inquiry

```text
Anjali Trivedi <anjali.parth.wedding@gmail.com>
Hey Anupya,

I’m reaching out to inquire about DJ services for my wedding.
Event type: Indian wedding ceremony + reception
Date: May 23rd, 2027
Location: The Rockleigh, Rockleigh, New Jersey
Estimated guest count: ~300
Services needed: Ceremony, cocktail hour, and reception DJ/MC

Best,
Anjali Trivedi
```

### 2) Follow-up timeline context (should map to same workspace)

```text
Anjali Trivedi
Hey, thanks for getting back to me!
Timeline:
9:00-10:00am Barat
10:00-12:00pm Wedding Ceremony
6:00-7:30pm Cocktail Hour
7:30-11:30pm Reception
I’m interested in dhol players & emcee services too.
```

### 3) Approved-style pricing response context

```text
Hi Harshala!

Great thanks for the info! Here are standard rates:
Sangeet (6:30 - 11:30) - $3000
Reception (6:30 - 11:30) - $3000

Best,
Anupya
```

Expected behavior:

- auto per-event amount uses `(duration + 1 hour) * $600`
- manual override stores explicit quoted amount (`$3000`)

### 4) Cancellation context

```text
We’ve decided to go with someone here to make logistics easier and bring cost down.
Thank you so much for all your help.
```

Expected behavior:

- workspace stage moves to `Cancelled`
- draft response shifts to supportive closeout language

## Repository Setup

If you want this folder as a separate remote repository:

```bash
git init
git add .
git commit -m "Initial standalone admin app"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```
