# Troubleshooting

## `Invalid bootstrap token.`

- Confirm the value in request header `x-admin-bootstrap-token`.
- Confirm the deployment environment has matching `ADMIN_BOOTSTRAP_TOKEN`.
- Ensure you are targeting the correct app URL and environment (Preview vs Production).

## `DATABASE_URL (or POSTGRES_URL) is required in production`

- Add `DATABASE_URL` or `POSTGRES_URL` in Vercel env vars.
- Redeploy after updating variables.

## `Cannot find package 'pg'`

- Ensure `pg` is in `dependencies` (not only `devDependencies`).
- Rebuild/redeploy after lockfile is updated.

## Login succeeds but workspace/auth session seems missing

- Verify cookie is present and sent back (`admin_session`).
- Check `GET /api/admin/auth/session`.
- Confirm `ADMIN_SESSION_SECRET` is stable for the deployment.

## Workspace 404 right after ingest

- Use `GET /api/admin/workspace/:eventId` with the returned `eventId`.
- If missing, verify runtime store is using Postgres (health endpoint + env vars).
- Ensure deployment includes latest code and completed build.

## `ENOENT ... /var/task/data/admin/...`

- On Vercel, runtime writable dir is `/tmp`.
- Configure `ADMIN_DATA_DIR=/tmp/data/admin` if needed.
- Use Postgres for durable state and file artifacts; `/tmp` is ephemeral and instance-local.

## OCR/context mapping fails for message screenshots

- Provide at least one contact method (email/phone/Instagram), or
- select target workspace in “Add To Workspace”.
- For failed OCR upload-only ingestion, include pasted context text fallback.
