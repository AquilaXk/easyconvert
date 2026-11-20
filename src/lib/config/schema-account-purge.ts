import type { VariableSpec } from './schema';

const WORKER = ['worker'] as const;

export const UNVERIFIED_ACCOUNT_PURGE_ENTRIES = [
  {
    name: 'UNVERIFIED_ACCOUNT_PURGE_ENABLED',
    area: 'auth',
    description:
      'Set to `true` to start the daily pass that deletes an account whose email address stayed unverified for 30 days, with its API keys, webhooks, credentials, files and usage (an account that holds a purchase is kept; docs/policy-decisions.md, entry 364). Off by default and then no timer runs: an account made while mail was off, or before it was on, could never confirm its address. Turn it on only where verification mail is on. A pass starts in dry-run mode (see `UNVERIFIED_ACCOUNT_PURGE_DRY_RUN`).',
    kind: { type: 'boolean' },
    default: false,
    requiredInProduction: false,
    secret: false,
    roles: WORKER,
  },
  {
    name: 'UNVERIFIED_ACCOUNT_PURGE_DRY_RUN',
    area: 'auth',
    description:
      'While `UNVERIFIED_ACCOUNT_PURGE_ENABLED` is `true`, a pass only logs how many accounts it would delete and claims and deletes nothing, until this is set to `false`. On by default, so switching the purge on first shows the counts of one pass.',
    kind: { type: 'boolean' },
    default: true,
    requiredInProduction: false,
    secret: false,
    roles: WORKER,
  },
] as const satisfies readonly VariableSpec[];
