# Disposable email domains

- Repository: https://github.com/disposable-email-domains/disposable-email-domains
- Path: `disposable_email_blocklist.conf`, `LICENSE.txt`
- Commit: `cecb78fa408e59479fe5c3968ee16627ff11746a`
- Fetched: 2026-11-15
- Domains: 10234
- Licence: CC0 1.0 Universal (public domain dedication, `LICENSE.txt`)

The list is vendored whole so that the server never reads the network for it. `src/lib/auth/disposable-email-domains.generated.ts` is
built from it by `scripts/refresh-disposable-email-domains.mjs`; `tests/disposable-email.test.ts` fails when the two differ.

Refresh: `node scripts/refresh-disposable-email-domains.mjs` (the default branch) or `--ref <sha>`, then commit the changed files.
