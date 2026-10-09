## Related Issue

- Closes #
- Related / Depends on:

## Summary

- Problem:
- Outcome:

## Changes

- 
- 

## Scope

### Included

- 

### Excluded

- 

## Verification

| Check | Command / Evidence | Status |
|---|---|---|
| Linter | `npm run lint` | Pass |
| Tests | `npm test` | Pass |
| Build | `npm run build` | Pass |

### Not Run

- None

## Risk & Delivery

- Risk: Low / Medium / High
- Main risk:
- Rollout / rollback / recovery: Not required

## Review Guide

- Review first:
- Key decision / trade-off:

## Checklist

- [ ] All automated tests and linter pass locally.
- [ ] Claude Code review findings are addressed and all review threads are resolved.
- [ ] Changes match acceptance criteria of the related issue.
- [ ] No extraneous files or secrets included.
- [ ] If a conversion family changed: `parity quality` passes, and the `automerge` label has been added so `parity speed` runs on the final commit (rows listed in `bench/parity-gaps.json` must not get slower than their recorded ratio).
