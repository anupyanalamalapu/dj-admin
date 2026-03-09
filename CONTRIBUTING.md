# Contributing

## Development Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

See `docs/START_HERE.md` for full onboarding.

## Branches and Commits

- Use focused commits with clear scope (`fix(auth): ...`, `refactor(persistence): ...`).
- Keep unrelated changes in separate commits.
- Avoid force-push on shared branches unless coordinated.

## Code Standards

- Keep API routes thin: parse input, call service, map response/errors.
- Keep domain logic in `lib/admin/orchestration/**`.
- Keep persistence logic in `lib/admin/persistence/**`.
- Add/adjust tests for behavior changes (especially auth, ingest, workspace routing, and persistence).
- Prefer small, reviewable diffs over broad rewrites.

## Required Checks

Before opening a PR:

```bash
npm run verify
```

This runs linting, type checking, admin tests, and build verification.

## Pull Request Expectations

- Explain behavior change and risk.
- Include test updates for new behavior.
- Note env var or migration impacts explicitly.
- Include rollback notes for storage/auth changes.
