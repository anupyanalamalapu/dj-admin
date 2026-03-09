# Architecture

## High-Level Flow

1. Admin logs in via `/api/admin/auth/login` (server-side session cookie).
2. Admin opens `/admin/inquiry` and submits context.
3. `POST /api/admin/inquiry/ingest` parses context and resolves or creates workspace data.
4. UI opens `/admin/workspace/:eventId`.
5. Workspace reads from `GET /api/admin/workspace/:eventId` and supports edits/checklist proof uploads.

## Module Boundaries

- `app/admin/**`
  - UI routes and page composition only.
- `app/api/admin/**`
  - Thin request/response handlers only.
  - Auth guard + input parsing + service call + status mapping.
- `lib/admin/orchestration/**`
  - Domain logic for inquiry ingestion, workspace/profile retrieval, updates, and checklist actions.
  - Public domain entrypoints:
    - `inquiry-service.ts`
    - `workspace-service.ts`
    - `contract-service.ts`
    - `profile-service.ts`
  - `admin-service.ts` is the current legacy implementation core.
- `lib/admin/persistence/**`
  - Runtime store and filesystem persistence adapters.
- `lib/admin/auth/**`
  - Bootstrap/login/session/rate-limit behavior and backend persistence.
- `lib/admin/config/**`
  - Runtime env validation and diagnostics.

## Runtime Storage Model

- Auth/session/rate-limit data:
  - Postgres in deployed environments.
  - SQLite fallback in local/dev if Postgres URL is absent.
- Workspace runtime state and file artifacts (uploads/contracts/client markdown):
  - Postgres-backed when Postgres is configured.
  - File-backed fallback for local scenarios.

This dual-mode design keeps local setup simple while using durable storage in production.

## Design Principles

- Keep routes thin.
- Keep domain logic in service modules.
- Keep persistence behind adapters.
- Prefer explicit validation failures over ambiguous runtime errors.
- Preserve existing admin workflow behavior unless a bug fix requires targeted change.
