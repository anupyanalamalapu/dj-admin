# ADR 0001: Runtime Store Backend Selection

## Status

Accepted

## Context

The admin app runs in both local development and serverless production environments.

- Local development benefits from simple file-backed state.
- Production requires durable shared state across serverless invocations.

Previously, runtime workspace state in production could drift when relying on instance-local files.

## Decision

Use adapter-based runtime storage with one selection point:

- Postgres adapter when `DATABASE_URL` or `POSTGRES_URL` is configured.
- File adapter fallback otherwise.

The module `lib/admin/persistence/store.ts` owns adapter selection.

## Consequences

- Production state is durable and shared.
- Local setup remains simple.
- Persistence concerns are isolated behind adapter interfaces, improving testability and code comprehension.
