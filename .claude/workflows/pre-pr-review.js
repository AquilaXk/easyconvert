export const meta = {
  name: 'pre-pr-review',
  description: 'Multi-lens review of the current branch with adversarial verification before opening a PR',
  whenToUse: 'Before opening or updating a PR that changes conversion engines, tests/oracles, security, or API code. Pass a base ref as the argument (default: origin/main).',
  phases: [
    { title: 'Scope', detail: 'classify the diff against the base ref' },
    { title: 'Review', detail: 'one reviewer per applicable lens' },
    { title: 'Verify', detail: 'one skeptic per finding tries to refute it' },
  ],
}

const BASE = typeof args === 'string' && args.trim() ? args.trim() : 'origin/main'

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['files', 'conversions', 'tests', 'security', 'summary'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    conversions: { type: 'boolean', description: 'touches src/lib/conversions, src/lib/edge, src/lib/registry.ts, or src/worker' },
    tests: { type: 'boolean', description: 'touches tests/ or tests/helpers/' },
    security: { type: 'boolean', description: 'touches src/lib/security, src/lib/auth, src/lib/api-keys, src/app/api, sandbox, or network fetching' },
    summary: { type: 'string' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'severity', 'summary', 'failure_scenario'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['important', 'nit'] },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
      },
    },
    not_run: { type: 'array', items: { type: 'string' }, description: 'checks that could not run and why' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

phase('Scope')
const scope = await agent(
  `Run \`git fetch origin --quiet\`, then list the files changed on this branch versus ${BASE} (\`git diff --name-only ${BASE}...HEAD\` plus uncommitted and untracked files) and classify the change. Summarize the intent in two sentences.`,
  { label: 'scope', phase: 'Scope', schema: SCOPE_SCHEMA, effort: 'low' },
)

if (!scope) {
  throw new Error('Scope agent did not return; the review did not run.')
}
if (scope.files.length === 0) {
  log(`No changes against ${BASE}; nothing to review.`)
  return { base: BASE, confirmed: [], dismissed: [], not_run: [] }
}

const DIFF_HINT = `Review only the changes on this branch versus ${BASE} (committed and uncommitted). Changed files: ${scope.files.join(', ')}. Intent: ${scope.summary}`

const LENSES = [
  {
    key: 'correctness',
    prompt: `${DIFF_HINT}\n\nFind correctness bugs and regressions introduced by the diff: wrong logic, off-by-one and byte-offset errors, unhandled edge cases, broken fail-closed behavior, resource leaks. Report only issues you can tie to a concrete failing input.`,
  },
  {
    key: 'architecture',
    prompt: `${DIFF_HINT}\n\nCheck the diff against the architecture boundaries and code rules in CLAUDE.md (layer boundaries, SSOT modules, node: imports, no nested ternaries, named constants, cloud-free local mocks, no hard-coded model names, no external service names). Mark pure style items as nit.`,
  },
]
if (scope.security) {
  LENSES.push({
    key: 'security',
    prompt: `${DIFF_HINT}\n\nAudit the diff for security defects: SSRF (IPv4/IPv6/DNS rebinding), path traversal, zip-slip and archive bombs, sandbox escapes, authn/authz gaps, API key handling, secrets or PII in logs and errors.`,
  })
}
if (scope.tests || scope.conversions) {
  LENSES.push({
    key: 'test-integrity',
    agentType: 'test-integrity-reviewer',
    prompt: `${DIFF_HINT}\n\nApply all test-integrity gates and return findings.`,
  })
}
if (scope.conversions) {
  LENSES.push({
    key: 'bitstream',
    agentType: 'bitstream-verifier',
    prompt: `${DIFF_HINT}\n\nVerify the outputs of the changed conversion paths with independent toolchains. Return every FAIL as an important finding (file/line of the responsible converter code) and every NOT RUN check in not_run.`,
  })
}
log(`Reviewing ${scope.files.length} files with lenses: ${LENSES.map(l => l.key).join(', ')}`)

const reviewed = await pipeline(
  LENSES,
  lens => agent(lens.prompt, {
    label: `review:${lens.key}`,
    phase: 'Review',
    schema: FINDINGS_SCHEMA,
    ...(lens.agentType ? { agentType: lens.agentType } : {}),
  }),
  (result, lens) => {
    if (!result) return { lens: lens.key, verified: [], not_run: [`${lens.key}: reviewer did not return`] }
    return parallel(result.findings.map(f => () =>
      agent(
        `Try to refute this code review finding. Read the cited code and its callers. Default to refuted=true unless you can confirm the failure scenario is reachable in this branch.\n\nFile: ${f.file}:${f.line}\nClaim: ${f.summary}\nFailure scenario: ${f.failure_scenario}`,
        { label: `verify:${f.file}:${f.line}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' },
      ).then(v => ({ ...f, lens: lens.key, verdict: v })),
    )).then(verified => ({ lens: lens.key, verified: verified.filter(Boolean), not_run: result.not_run || [] }))
  },
)

const SEVERITY_RANK = { important: 0, nit: 1 }
const results = reviewed.filter(Boolean)
const all = results.flatMap(r => r.verified)
const confirmed = all
  .filter(f => f.verdict && !f.verdict.refuted)
  .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
const dismissed = all.filter(f => f.verdict && f.verdict.refuted)
const unverified = all.filter(f => !f.verdict)
const notRun = results.flatMap(r => r.not_run)

log(`${confirmed.length} confirmed, ${unverified.length} unverified, ${dismissed.length} dismissed, ${notRun.length} checks not run`)
return { base: BASE, lenses: LENSES.map(l => l.key), confirmed, unverified, dismissed, not_run: notRun }
