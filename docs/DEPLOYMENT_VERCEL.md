# Deployment on Vercel

## Required Environment Variables

Set these in **Project Settings -> Environment Variables** for Preview and Production:

- `ADMIN_SESSION_SECRET` (>= 32 chars)
- `ADMIN_BOOTSTRAP_TOKEN`
- `DATABASE_URL` (or `POSTGRES_URL`)

Optional AI variables:

- `ADMIN_ENABLE_CODEX_AI`
- `OPENAI_API_KEY`
- `ADMIN_CODEX_MODEL_EXTRACT`
- `ADMIN_CODEX_MODEL_MATCH`
- `ADMIN_CODEX_MODEL_EMAIL`
- `ADMIN_CODEX_MODEL_AMENDMENT`
- `ADMIN_CODEX_MODEL_SUMMARY`
- `ADMIN_ENABLE_AI_OCR`
- `ADMIN_CODEX_MODEL_OCR`

## Postgres Notes

- If your provider injects prefixed env vars (for example `STORAGE_POSTGRES_*`), also define `DATABASE_URL` or `POSTGRES_URL` directly for this app.
- Production auth, runtime workspace state, and runtime file artifacts require durable Postgres connectivity.

## Redeploy Checklist

1. Push `main`.
2. Confirm Vercel deployment build passes.
3. Verify `/api/admin/config/health` after login.
4. Run smoke tests:

```bash
APP="https://<your-app>.vercel.app"
curl -i -c /tmp/admin.cookies -X POST "$APP/api/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<password>"}'

curl -i -b /tmp/admin.cookies "$APP/api/admin/auth/session"
curl -i -b /tmp/admin.cookies "$APP/api/admin/config/health"
```

## First-Admin Bootstrap in Production

Run once when no admin exists:

```bash
curl -X POST "https://<your-app>.vercel.app/api/admin/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -H "x-admin-bootstrap-token: <ADMIN_BOOTSTRAP_TOKEN>" \
  -d '{"username":"admin","password":"StrongPass!123456"}'
```

If an admin already exists, bootstrap endpoint is intentionally blocked.
