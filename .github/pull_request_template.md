## Summary

- What changed:
- Why:

## Risk & Impact

- Affected areas:
- Backward compatibility:
- Migration/env impact:

## Validation

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:admin`
- [ ] `npm run build`

## Checklist

- [ ] Routes remain thin (no business logic added to handlers/pages)
- [ ] Domain logic is in service modules
- [ ] Persistence changes are adapter-contained
- [ ] Tests added/updated for behavior changes
- [ ] Docs updated (`README` / `docs/*`) if needed
