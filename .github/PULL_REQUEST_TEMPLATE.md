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
- [ ] If a policy or default changed: `docs/policy-decisions.md` is updated with the decision, why it is right in practice, its benefits and trade-offs, the alternatives rejected, and how it is verified.
- [ ] If a conversion family changed: `parity quality` passes, and add the `automerge` label as the last step: the merge queue then runs `parity speed` on the commit it merges (a row listed in `bench/parity-gaps.json` fails when its median falls below the 99% prediction bound of its CI history or below 65% of the median of that history, whichever is higher).
