import { afterEach, describe, expect, it } from 'vitest';
import node_child_process from 'node:child_process';
import node_fs from 'node:fs';
import node_os from 'node:os';
import node_path from 'node:path';

/**
 * Oracle for the notices generator: the production set is re-derived here from package-lock.json with its own
 * parser (no code shared with scripts/third-party-notices.mjs), and the red cases run the script against
 * temporary fixture lockfiles so the real notices, allowlist and lockfile are never touched.
 */

const REPO_ROOT = process.cwd();
const SCRIPT = node_path.join(REPO_ROOT, 'scripts', 'third-party-notices.mjs');
const NOTICES_PATH = node_path.join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');
const LOCKFILE_PATH = node_path.join(REPO_ROOT, 'package-lock.json');
const ALLOW_PATH = node_path.join(REPO_ROOT, 'licenses.allow.json');

const EXIT_POLICY_FAILURE = 1;
const EXIT_MALFORMED_INPUT = 2;
const SCRIPT_TIMEOUT_MS = 60_000;
const NODE_MODULES_SEGMENT = 'node_modules/';
const HEADING_PATTERN = /^### (.+)$/;
const LICENSE_LINE_PATTERN = /^- \*\*License\*\*: `(.+)`$/;
const TEXT_FENCE = '```text';

interface LockEntry {
  version: string;
  license?: string;
  dev?: boolean;
  optional?: boolean;
}

interface Oracle {
  /** name@version -> licence, for every production entry of the real lockfile. */
  licences: Map<string, string>;
  /** name@version of production entries that are optional only. */
  optional: Set<string>;
}

/** Independent lockfile reader: production = every entry except the root and `dev: true`. */
function readOracle(): Oracle {
  const lock = JSON.parse(node_fs.readFileSync(LOCKFILE_PATH, 'utf8')) as { packages: Record<string, LockEntry> };
  const licences = new Map<string, string>();
  const optional = new Set<string>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.dev === true) continue;
    const name = key.slice(key.lastIndexOf(NODE_MODULES_SEGMENT) + NODE_MODULES_SEGMENT.length);
    const id = `${name}@${entry.version}`;
    licences.set(id, entry.license ?? '');
    if (entry.optional === true) optional.add(id);
  }
  return { licences, optional };
}

interface Section {
  id: string;
  license: string;
  body: string;
}

/** Splits a notices file into one section per `### name@version` heading. */
function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: { id: string; license: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (current) sections.push({ id: current.id, license: current.license, body: current.lines.join('\n') });
  };
  let fenceLength = 0;
  for (const line of markdown.split('\n')) {
    // Licence text may contain lines that look like headings; only parse outside code fences.
    const fence = /^(`{3,})/.exec(line);
    if (fenceLength === 0 && fence) fenceLength = fence[1].length;
    else if (fenceLength > 0 && fence && fence[1].length >= fenceLength && line.trim() === fence[1]) fenceLength = 0;
    const heading = fenceLength === 0 ? HEADING_PATTERN.exec(line) : null;
    if (heading) {
      flush();
      current = { id: heading[1], license: '', lines: [] };
      continue;
    }
    if (!current) continue;
    const lic = fenceLength === 0 ? LICENSE_LINE_PATTERN.exec(line) : null;
    if (lic && current.license === '') current.license = lic[1];
    current.lines.push(line);
  }
  flush();
  return sections;
}

describe('Third-party notices against the real lockfile', () => {
  it('lists exactly the production lockfile packages with the lockfile licences', () => {
    const oracle = readOracle();
    const sections = parseSections(node_fs.readFileSync(NOTICES_PATH, 'utf8'));
    const listed = new Map(sections.map((s) => [s.id, s.license]));
    expect(sections.length).toBe(listed.size);
    expect([...listed.keys()].sort()).toEqual([...oracle.licences.keys()].sort());
    for (const [id, lockLicence] of oracle.licences) {
      // The only production entry without a lockfile licence is covered by an exception that names its licence.
      if (lockLicence !== '') expect(listed.get(id), id).toBe(lockLicence);
    }
    expect(oracle.licences.size).toBeGreaterThan(100);
  });

  it('embeds licence text for non-optional packages only', () => {
    const oracle = readOracle();
    const sections = parseSections(node_fs.readFileSync(NOTICES_PATH, 'utf8'));
    for (const section of sections) {
      const hasText = section.body.includes(TEXT_FENCE);
      if (oracle.optional.has(section.id)) {
        expect(hasText, `${section.id} is optional and must not embed text`).toBe(false);
        expect(section.body, section.id).toContain('ships in the package');
      }
    }
    const withText = sections.filter((s) => s.body.includes(TEXT_FENCE));
    const nextSection = sections.find((s) => s.id.startsWith('next@'));
    expect(withText.length).toBeGreaterThan(50);
    expect(nextSection?.body).toContain(TEXT_FENCE);
  });

  it('passes --check against the committed files', () => {
    const run = node_child_process.spawnSync(process.execPath, [SCRIPT, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SCRIPT_TIMEOUT_MS,
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('keeps the allowlist free of network-copyleft licences', () => {
    const allow = JSON.parse(node_fs.readFileSync(ALLOW_PATH, 'utf8')) as { allowed: string[] };
    expect(allow.allowed).toContain('MIT');
    expect(allow.allowed).toContain('Apache-2.0');
    expect(allow.allowed.filter((l) => /AGPL|GPL-[23]\.0(-only|-or-later)?$/.test(l) && !l.startsWith('LGPL'))).toEqual([]);
  });
});

interface FixturePackage {
  path: string;
  version: string;
  license?: string;
  dev?: boolean;
  optional?: boolean;
  /** Install the package under the fixture node_modules with this LICENSE text. */
  installedText?: string;
}

interface Workspace {
  dir: string;
  lockfile: string;
  allow: string;
  output: string;
  nodeModules: string;
}

const workspaces: string[] = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) node_fs.rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(packages: FixturePackage[], allow?: object): Workspace {
  const dir = node_fs.mkdtempSync(node_path.join(node_os.tmpdir(), 'notices-'));
  workspaces.push(dir);
  const ws: Workspace = {
    dir,
    lockfile: node_path.join(dir, 'package-lock.json'),
    allow: node_path.join(dir, 'licenses.allow.json'),
    output: node_path.join(dir, 'NOTICES.md'),
    nodeModules: node_path.join(dir, 'node_modules'),
  };
  node_fs.mkdirSync(ws.nodeModules);
  writeLockfile(ws, packages);
  node_fs.writeFileSync(ws.allow, JSON.stringify(allow ?? { allowed: ['MIT', 'ISC', 'Apache-2.0', 'LGPL-3.0'], exceptions: {} }));
  for (const pkg of packages) installPackage(ws, pkg);
  return ws;
}

function installPackage(ws: Workspace, pkg: FixturePackage): void {
  if (pkg.installedText === undefined) return;
  const pkgDir = node_path.join(ws.nodeModules, pkg.path);
  node_fs.mkdirSync(pkgDir, { recursive: true });
  node_fs.writeFileSync(node_path.join(pkgDir, 'package.json'), JSON.stringify({ name: pkg.path, version: pkg.version }));
  node_fs.writeFileSync(node_path.join(pkgDir, 'LICENSE'), pkg.installedText);
}

function writeLockfile(ws: Workspace, packages: FixturePackage[]): void {
  const entries: Record<string, object> = { '': { name: 'fixture-root', version: '0.0.0', license: 'MIT' } };
  for (const pkg of packages) {
    entries[`node_modules/${pkg.path}`] = {
      version: pkg.version,
      resolved: `https://registry.example.test/${pkg.path}/-/pkg-${pkg.version}.tgz`,
      ...(pkg.license === undefined ? {} : { license: pkg.license }),
      ...(pkg.dev ? { dev: true } : {}),
      ...(pkg.optional ? { optional: true } : {}),
    };
  }
  node_fs.writeFileSync(ws.lockfile, JSON.stringify({ name: 'fixture-root', lockfileVersion: 3, packages: entries }));
}

function runScript(ws: Workspace, extraArgs: string[] = []): { status: number | null; stdout: string; stderr: string } {
  // cwd is the temporary directory, so a run can never reach the real notices file.
  const run = node_child_process.spawnSync(
    process.execPath,
    [SCRIPT, '--lockfile', ws.lockfile, '--allow', ws.allow, '--output', ws.output, '--node-modules', ws.nodeModules, ...extraArgs],
    { cwd: ws.dir, encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const MIT_TEXT = 'MIT License\n\nCopyright (c) Fixture Authors\n\nPermission is hereby granted, free of charge.\n';
const BASE_PACKAGES: FixturePackage[] = [
  { path: 'beta/node_modules/alpha', version: '2.0.0', license: 'MIT', installedText: MIT_TEXT },
  { path: 'alpha', version: '1.0.0', license: 'MIT', installedText: MIT_TEXT },
  { path: '@scope/zeta', version: '1.0.0', license: 'ISC', installedText: 'ISC License\n\nCopyright Zeta\n' },
  { path: 'beta/node_modules/nested', version: '3.1.0', license: 'Apache-2.0', installedText: 'Apache nested text\n' },
  { path: 'devonly', version: '9.9.9', license: 'GPL-3.0-only', dev: true },
];

describe('Third-party notices generator on fixture lockfiles', () => {
  it('writes sorted production sections and skips dev and root entries', () => {
    const ws = makeWorkspace(BASE_PACKAGES);
    const run = runScript(ws);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const sections = parseSections(node_fs.readFileSync(ws.output, 'utf8'));
    // Hand-written golden: code-unit order by name, then version; nested path keeps only the last segment.
    expect(sections.map((s) => s.id)).toEqual(['@scope/zeta@1.0.0', 'alpha@1.0.0', 'alpha@2.0.0', 'nested@3.1.0']);
    expect(sections.map((s) => s.license)).toEqual(['ISC', 'MIT', 'MIT', 'Apache-2.0']);
    const alpha = sections.find((s) => s.id === 'alpha@1.0.0');
    expect(alpha?.body).toContain('Copyright (c) Fixture Authors');
  });

  it('is byte-identical across runs and independent of optional packages installed on the host', () => {
    const optionalAbsent: FixturePackage = { path: '@img/sharp-fixture-os', version: '1.2.3', license: 'Apache-2.0', optional: true };
    const wsAbsent = makeWorkspace([...BASE_PACKAGES, optionalAbsent]);
    const wsPresent = makeWorkspace([...BASE_PACKAGES, { ...optionalAbsent, installedText: 'HOST-SPECIFIC-OPTIONAL-TEXT' }]);
    expect(runScript(wsAbsent).status).toBe(0);
    expect(runScript(wsPresent).status).toBe(0);
    const absent = node_fs.readFileSync(wsAbsent.output, 'utf8');
    const present = node_fs.readFileSync(wsPresent.output, 'utf8');
    expect(present).toBe(absent);
    expect(absent).not.toContain('HOST-SPECIFIC-OPTIONAL-TEXT');
    const optionalSection = parseSections(absent).find((s) => s.id === '@img/sharp-fixture-os@1.2.3');
    expect(optionalSection?.license).toBe('Apache-2.0');
    expect(optionalSection?.body).toContain('ships in the package');
    expect(runScript(wsAbsent).status).toBe(0);
    expect(node_fs.readFileSync(wsAbsent.output, 'utf8')).toBe(absent);
  });

  it('--check passes on a fresh file and exits 1 with a summary when the file differs', () => {
    const ws = makeWorkspace(BASE_PACKAGES);
    expect(runScript(ws).status).toBe(0);
    const fresh = runScript(ws, ['--check']);
    expect(fresh.stderr).toBe('');
    expect(fresh.status).toBe(0);

    const gamma: FixturePackage = { path: 'gamma', version: '1.0.0', license: 'MIT', installedText: MIT_TEXT };
    writeLockfile(ws, [...BASE_PACKAGES, gamma]);
    installPackage(ws, gamma);
    const drift = runScript(ws, ['--check']);
    expect(drift.status).toBe(EXIT_POLICY_FAILURE);
    expect(drift.stderr).toContain('out of date');
    expect(drift.stderr).toContain('added: gamma@1.0.0');
  });

  it('--check exits 1 when the notices file is missing or hand-edited', () => {
    const ws = makeWorkspace(BASE_PACKAGES);
    const missing = runScript(ws, ['--check']);
    expect(missing.status).toBe(EXIT_POLICY_FAILURE);
    expect(missing.stderr).toContain('does not exist');

    expect(runScript(ws).status).toBe(0);
    const original = node_fs.readFileSync(ws.output, 'utf8');
    node_fs.writeFileSync(ws.output, original.replace('Copyright (c) Fixture Authors', 'Copyright (c) Someone Else'));
    const edited = runScript(ws, ['--check']);
    expect(edited.status).toBe(EXIT_POLICY_FAILURE);
    expect(edited.stderr).toContain('out of date');
  });

  it('rejects a GPL-3.0-only package and writes nothing', () => {
    const ws = makeWorkspace([...BASE_PACKAGES, { path: 'copyleft', version: '1.0.0', license: 'GPL-3.0-only', installedText: 'GPL' }]);
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_POLICY_FAILURE);
    expect(run.stderr).toContain('Licence policy failed');
    expect(run.stderr).toContain('copyleft@1.0.0: GPL-3.0-only');
    expect(node_fs.existsSync(ws.output)).toBe(false);
  });

  it('rejects an AGPL-only package', () => {
    const ws = makeWorkspace([{ path: 'network', version: '1.0.0', license: 'AGPL-3.0-only', installedText: 'AGPL' }]);
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_POLICY_FAILURE);
    expect(run.stderr).toContain('Licence policy failed');
    expect(run.stderr).toContain('network@1.0.0: AGPL-3.0-only');
  });

  it('rejects an AND expression with one disallowed part', () => {
    const ws = makeWorkspace([{ path: 'mixed', version: '1.0.0', license: '(MIT AND GPL-3.0-only)', installedText: 'text' }]);
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_POLICY_FAILURE);
    expect(run.stderr).toContain('Licence policy failed');
    expect(run.stderr).toContain('mixed@1.0.0: (MIT AND GPL-3.0-only)');
  });

  it('accepts an AND expression whose parts are all allowed and an OR with one allowed branch', () => {
    const ws = makeWorkspace([
      { path: 'both', version: '1.0.0', license: 'MIT AND ISC', installedText: 'text' },
      { path: 'either', version: '1.0.0', license: '(GPL-3.0-or-later OR MIT)', installedText: 'text' },
    ]);
    const run = runScript(ws);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(parseSections(node_fs.readFileSync(ws.output, 'utf8')).map((s) => s.license)).toEqual(['MIT AND ISC', '(GPL-3.0-or-later OR MIT)']);
  });

  it('rejects an OR expression whose branches are all disallowed', () => {
    const ws = makeWorkspace([{ path: 'dualcopyleft', version: '1.0.0', license: '(GPL-3.0-only OR AGPL-3.0-only)', installedText: 'text' }]);
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_POLICY_FAILURE);
    expect(run.stderr).toContain('Licence policy failed');
    expect(run.stderr).toContain('dualcopyleft@1.0.0: (GPL-3.0-only OR AGPL-3.0-only)');
  });

  it('binds AND tighter than OR', () => {
    const ws = makeWorkspace([{ path: 'precedence', version: '1.0.0', license: 'MIT OR GPL-3.0-only AND GPL-2.0-only', installedText: 'text' }]);
    expect(runScript(ws).status).toBe(0);
    const reversed = makeWorkspace([{ path: 'precedence', version: '1.0.0', license: 'GPL-3.0-only OR GPL-2.0-only AND MIT', installedText: 'text' }]);
    expect(runScript(reversed).status).toBe(EXIT_POLICY_FAILURE);
  });

  it('rejects a package with no licence unless an exact name@version exception gives a reason', () => {
    const packages: FixturePackage[] = [{ path: 'nolicence', version: '1.0.0', installedText: 'MIT License text' }];
    const ws = makeWorkspace(packages);
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_POLICY_FAILURE);
    expect(run.stderr).toContain('Licence policy failed');
    expect(run.stderr).toContain('nolicence@1.0.0: no licence');
    expect(node_fs.existsSync(ws.output)).toBe(false);

    node_fs.writeFileSync(
      ws.allow,
      JSON.stringify({ allowed: ['MIT'], exceptions: { 'nolicence@1.0.0': { license: 'MIT', reason: 'Checked by hand: the tarball ships an MIT LICENSE file' } } }),
    );
    const excepted = runScript(ws);
    expect(excepted.stderr).toBe('');
    expect(excepted.status).toBe(0);
    expect(parseSections(node_fs.readFileSync(ws.output, 'utf8'))[0].license).toBe('MIT');
  });

  it('does not apply an exception to a different version of the package', () => {
    const ws = makeWorkspace([{ path: 'nolicence', version: '1.0.1', installedText: 'text' }]);
    node_fs.writeFileSync(
      ws.allow,
      JSON.stringify({ allowed: ['MIT'], exceptions: { 'nolicence@1.0.0': { license: 'MIT', reason: 'reviewed' } } }),
    );
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_POLICY_FAILURE);
    expect(run.stderr).toContain('Licence policy failed');
    expect(run.stderr).toContain('nolicence@1.0.1: no licence');
  });

  it('rejects an unparseable licence string', () => {
    const ws = makeWorkspace([{ path: 'weird', version: '1.0.0', license: 'SEE LICENSE IN LICENSE.txt', installedText: 'text' }]);
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_POLICY_FAILURE);
    expect(run.stderr).toContain('weird@1.0.0: unparseable licence');
  });

  it('never infers a missing licence from the licence file text', () => {
    const ws = makeWorkspace([{ path: 'looksmit', version: '1.0.0', installedText: MIT_TEXT }]);
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_POLICY_FAILURE);
    expect(run.stderr).toContain('looksmit@1.0.0: no licence');
  });

  it('rejects a stale exception whose package is not in the production lockfile', () => {
    const ws = makeWorkspace(BASE_PACKAGES);
    node_fs.writeFileSync(
      ws.allow,
      JSON.stringify({
        allowed: ['MIT', 'ISC', 'Apache-2.0'],
        exceptions: { 'ghost@9.9.9': { license: 'MIT', reason: 'was needed once' }, 'devonly@9.9.9': { license: 'MIT', reason: 'dev only' } },
      }),
    );
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_POLICY_FAILURE);
    expect(run.stderr).toContain('Licence policy failed');
    expect(run.stderr).toContain('stale exception ghost@9.9.9');
    expect(run.stderr).toContain('stale exception devonly@9.9.9');
  });

  it('rejects an exception without a reason as malformed input', () => {
    const ws = makeWorkspace(BASE_PACKAGES);
    node_fs.writeFileSync(ws.allow, JSON.stringify({ allowed: ['MIT'], exceptions: { 'alpha@1.0.0': { license: 'MIT' } } }));
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_MALFORMED_INPUT);
    expect(run.stderr).toContain('AllowlistError');
  });

  it('fails a non-optional package that is not installed instead of guessing its text', () => {
    const ws = makeWorkspace([{ path: 'missing', version: '1.0.0', license: 'MIT' }]);
    const run = runScript(ws);
    expect(run.status).toBe(EXIT_MALFORMED_INPUT);
    expect(run.stderr).toContain('InstallError');
    expect(run.stderr).toContain('missing@1.0.0');
  });

  it('throws typed errors for a malformed or unsupported lockfile', () => {
    const ws = makeWorkspace(BASE_PACKAGES);
    node_fs.writeFileSync(ws.lockfile, '{ not json');
    const broken = runScript(ws);
    expect(broken.status).toBe(EXIT_MALFORMED_INPUT);
    expect(broken.stderr).toContain('LockfileError');

    node_fs.writeFileSync(ws.lockfile, JSON.stringify({ lockfileVersion: 2, packages: {} }));
    const oldVersion = runScript(ws);
    expect(oldVersion.status).toBe(EXIT_MALFORMED_INPUT);
    expect(oldVersion.stderr).toContain('lockfileVersion');
  });

  it('fences licence text that itself contains a code fence', () => {
    const ws = makeWorkspace([{ path: 'fenced', version: '1.0.0', license: 'MIT', installedText: 'before\n```\ninside\n```\nafter\n' }]);
    expect(runScript(ws).status).toBe(0);
    const output = node_fs.readFileSync(ws.output, 'utf8');
    expect(output).toContain('````text\nbefore\n```\ninside\n```\nafter\n````');
  });
});

describe('worker image build context', () => {
  /** Docker applies .dockerignore rules in order and the last matching rule decides. */
  function excludedFromContext(file: string, rules: string[]): boolean {
    let excluded = false;
    for (const raw of rules) {
      const rule = raw.trim();
      if (!rule || rule.startsWith('#')) continue;
      const negated = rule.startsWith('!');
      const pattern = negated ? rule.slice(1) : rule;
      const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
      if (regex.test(file)) excluded = !negated;
    }
    return excluded;
  }

  it('sends THIRD_PARTY_NOTICES.md to the image build that copies it', () => {
    const dockerfile = node_fs.readFileSync(node_path.join(REPO_ROOT, 'Dockerfile.worker'), 'utf8');
    expect(dockerfile).toMatch(/^COPY THIRD_PARTY_NOTICES\.md \/licenses\/$/m);
    const rules = node_fs.readFileSync(node_path.join(REPO_ROOT, '.dockerignore'), 'utf8').split('\n');
    expect(excludedFromContext('README.md', rules)).toBe(true);
    expect(excludedFromContext('THIRD_PARTY_NOTICES.md', rules)).toBe(false);
  });
});
