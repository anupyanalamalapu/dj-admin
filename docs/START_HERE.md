# START HERE

This guide gets a new developer from clone to productive in ~15 minutes.

## 1) Install and Run

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000/admin/login`.

## 2) Bootstrap First Admin (One-Time Per Environment)

```bash
curl -X POST "http://localhost:3000/api/admin/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -H "x-admin-bootstrap-token: $ADMIN_BOOTSTRAP_TOKEN" \
  -d '{"username":"admin","password":"StrongPass!123456"}'
```

Then log in through `/admin/login`.

## 3) Core Commands

```bash
npm run dev
npm run build
npm run test:admin
npm run verify
```

## 4) Where To Start In Code

- Routes/API entrypoints: `app/api/admin/**`
- Protected admin pages: `app/admin/(protected)/**`
- Domain orchestration services: `lib/admin/orchestration/**`
- Auth and session storage: `lib/admin/auth/**`
- Runtime store adapters: `lib/admin/persistence/**`
- Tests: `tests/admin/**`

## 5) Local Data

- Runtime JSON/files root: `ADMIN_DATA_DIR` (defaults to `data/admin` in dev, `/tmp/data/admin` in production serverless)
- Auth/session backend:
  - Postgres when `DATABASE_URL` or `POSTGRES_URL` is set
  - SQLite fallback for local-only auth if Postgres is not configured

## 6) First Debug Checkpoints

- Auth/config health (requires admin session): `GET /api/admin/config/health`
- Session check: `GET /api/admin/auth/session`
- Inquiry ingest API: `POST /api/admin/inquiry/ingest`
- Workspace fetch API: `GET /api/admin/workspace/:eventId`
