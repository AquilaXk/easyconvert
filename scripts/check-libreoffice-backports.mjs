#!/usr/bin/env node
/**
 * Checks whether Debian `trixie-backports` still offers the LibreOffice and Orcus
 * versions pinned in `Dockerfile.worker` on both `amd64` and `arm64`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_DOCKERFILE_BYTES = 256 * 1024;
export const MAX_POLICY_BYTES = 1024 * 1024;
export const ARCHITECTURES = ['amd64', 'arm64'];
const BACKPORTS_PREFIX = 'trixie-backports/';
const ALLOWED_CLIS = new Set(['docker', 'podman']);
const CONTAINER_TIMEOUT_MS = 180_000;
const CONTAINER_MAX_BUFFER = 4 * 1024 * 1024;
const PIN_BUMP_HINT =
  'check LibreOffice advisories and bump LIBREOFFICE_VERSION, LIBORCUS_VERSION and the liborcus package names in Dockerfile.worker together';

function canonicalImageRef(image) {
  const firstSegment = image.split(/[:@]/, 1)[0];
  return firstSegment.includes('/') ? image : `docker.io/library/${image}`;
}

function extractArg(section, name) {
  const match = new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(section);
  if (!match) throw new Error(`Dockerfile.worker has no ARG ${name}`);
  return match[1];
}

function collectPinnedPackages(runnerSection, libreofficeVersion, orcusVersion) {
  const packages = [];
  const linePattern = /^\s+(libreoffice-[a-z0-9-]+|liborcus-[a-z0-9.-]+)=\$\{(LIBREOFFICE_VERSION|LIBORCUS_VERSION)\}\s*\\?\s*$/;
  for (const line of runnerSection.split(/\r?\n/)) {
    const match = linePattern.exec(line);
    if (!match) continue;
    const [, name, argVar] = match;
    const isOrcus = argVar === 'LIBORCUS_VERSION';
    packages.push({
      name,
      expected: isOrcus ? orcusVersion : libreofficeVersion,
      source: isOrcus ? 'liborcus' : 'libreoffice',
      archIndependent: name === 'libreoffice-common',
    });
  }
  if (!packages.some((entry) => entry.source === 'libreoffice')) {
    throw new Error('Dockerfile.worker runner stage pins no libreoffice packages');
  }
  if (!packages.some((entry) => entry.source === 'liborcus')) {
    throw new Error('Dockerfile.worker runner stage pins no liborcus packages');
  }
  return packages;
}

/** Extracts the pinned base image, versions and package list from `Dockerfile.worker`. */
export function readDockerfileBackportsSpec(dockerfileText) {
  if (typeof dockerfileText !== 'string' || dockerfileText.length === 0) {
    throw new Error('Dockerfile.worker content must be a non-empty string');
  }
  if (dockerfileText.length > MAX_DOCKERFILE_BYTES) {
    throw new Error(`Dockerfile.worker exceeds ${MAX_DOCKERFILE_BYTES} bytes`);
  }
  const runnerIndex = dockerfileText.indexOf(' AS runner');
  if (runnerIndex < 0) throw new Error('Dockerfile.worker has no runner stage');
  const header = dockerfileText.slice(0, runnerIndex);
  const runnerSection = dockerfileText.slice(runnerIndex);
  const nodeImage = canonicalImageRef(extractArg(header, 'NODE_IMAGE'));
  const libreofficeVersion = extractArg(runnerSection, 'LIBREOFFICE_VERSION');
  const orcusVersion = extractArg(runnerSection, 'LIBORCUS_VERSION');
  const packages = collectPinnedPackages(runnerSection, libreofficeVersion, orcusVersion);
  return { nodeImage, libreofficeVersion, orcusVersion, packages };
}

function addBackportVersion(backports, key, version) {
  const list = backports.get(key);
  if (!list) {
    backports.set(key, [version]);
    return;
  }
  if (!list.includes(version)) list.push(version);
}

function recordVersionTableLine(state, line, backports) {
  const originMatch = /^\s+\d+\s+\S+\s+(\S+)\s+([a-z0-9]+)\s+Packages\s*$/.exec(line);
  if (originMatch) {
    const [, suite, originArch] = originMatch;
    if (state.currentVersion && suite.startsWith(BACKPORTS_PREFIX)) {
      addBackportVersion(backports, `${state.pkg}:${originArch}`, state.currentVersion);
    }
    return;
  }
  const versionMatch = /^\s+(?:\*\*\*\s+)?(\S+)\s+-?\d+(?:\s+\([^)]*\))?\s*$/.exec(line);
  if (versionMatch) state.currentVersion = versionMatch[1];
}

/** Parses `apt-cache policy` output into per-`(package, arch)` candidates and `trixie-backports` versions. */
export function parseAptCachePolicy(text, nativeArch) {
  if (typeof text !== 'string') throw new TypeError('apt-cache policy output must be a string');
  if (text.length > MAX_POLICY_BYTES) throw new Error(`apt-cache policy output exceeds ${MAX_POLICY_BYTES} bytes`);
  if (!ARCHITECTURES.includes(nativeArch)) throw new Error(`Unsupported native architecture: ${String(nativeArch)}`);

  const candidates = new Map();
  const backports = new Map();
  const state = { pkg: null, arch: nativeArch, inTable: false, currentVersion: null };

  for (const line of text.split(/\r?\n/)) {
    const headerMatch = /^([a-z0-9.+-]+)(?::([a-z0-9]+))?:\s*$/.exec(line);
    if (headerMatch) {
      state.pkg = headerMatch[1];
      state.arch = headerMatch[2] ?? nativeArch;
      state.inTable = false;
      state.currentVersion = null;
      continue;
    }
    if (!state.pkg) continue;
    const candidateMatch = /^\s+Candidate:\s+(\S+)\s*$/.exec(line);
    if (candidateMatch) {
      candidates.set(`${state.pkg}:${state.arch}`, candidateMatch[1]);
      continue;
    }
    if (/^\s+Version table:\s*$/.test(line)) {
      state.inTable = true;
      state.currentVersion = null;
      continue;
    }
    if (state.inTable) recordVersionTableLine(state, line, backports);
  }
  return { candidates, backports };
}

function evaluatePackageArch(pkgSpec, arch, backports) {
  const versions = backports.get(`${pkgSpec.name}:${arch}`) ?? [];
  if (versions.length === 0) {
    return {
      cell: 'missing',
      fault: `${pkgSpec.name} (${arch}): absent from trixie-backports (pinned ${pkgSpec.expected}; ${PIN_BUMP_HINT})`,
      warning: null,
    };
  }
  if (!versions.includes(pkgSpec.expected)) {
    const available = versions.join(', ');
    return {
      cell: available,
      fault: `${pkgSpec.name} (${arch}): trixie-backports has ${available}, replacing pinned ${pkgSpec.expected} (${PIN_BUMP_HINT})`,
      warning: null,
    };
  }
  if (versions.length > 1) {
    const available = versions.join(', ');
    return {
      cell: available,
      fault: null,
      warning: `${pkgSpec.name} (${arch}): trixie-backports lists ${available} alongside pinned ${pkgSpec.expected}`,
    };
  }
  return { cell: pkgSpec.expected, fault: null, warning: null };
}

function packageStatus(faultCount, hasWarning) {
  if (faultCount > 0) return 'FAIL';
  return hasWarning ? 'warn' : 'ok';
}

function formatSummaryTable(rows) {
  const lines = [
    '### LibreOffice and Orcus pins in trixie-backports',
    '',
    '| Package | Pinned | amd64 | arm64 | Result |',
    '|---|---|---|---|---|',
  ];
  for (const row of rows) {
    lines.push(`| \`${row.name}\` | \`${row.expected}\` | \`${row.amd64}\` | \`${row.arm64}\` | ${row.status} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Verifies every pinned LibreOffice and Orcus package against parsed `apt-cache policy` output. */
export function checkBackportsPolicy(spec, parsed, nativeArch) {
  if (!ARCHITECTURES.includes(nativeArch)) throw new Error(`Unsupported native architecture: ${String(nativeArch)}`);
  /** @type {string[]} */
  const faults = [];
  /** @type {string[]} */
  const warnings = [];
  const rows = [];

  for (const pkgSpec of spec.packages) {
    const amd64Result = evaluatePackageArch(pkgSpec, 'amd64', parsed.backports);
    const arm64Result = evaluatePackageArch(pkgSpec, 'arm64', parsed.backports);
    /** @type {string[]} */
    const packageFaults = [];
    if (amd64Result.fault) packageFaults.push(amd64Result.fault);
    if (arm64Result.fault) packageFaults.push(arm64Result.fault);
    if (amd64Result.warning) warnings.push(amd64Result.warning);
    if (arm64Result.warning) warnings.push(arm64Result.warning);

    if (pkgSpec.source === 'libreoffice') {
      const candidate = parsed.candidates.get(`${pkgSpec.name}:${nativeArch}`);
      if (candidate !== pkgSpec.expected) {
        packageFaults.push(
          `${pkgSpec.name} (${nativeArch}): apt candidate is ${candidate ?? '(none)'} instead of pinned ${pkgSpec.expected}`
        );
      }
    }
    faults.push(...packageFaults);
    rows.push({
      name: pkgSpec.name,
      expected: pkgSpec.expected,
      amd64: amd64Result.cell,
      arm64: arm64Result.cell,
      status: packageStatus(packageFaults.length, Boolean(amd64Result.warning || arm64Result.warning)),
    });
  }

  return { ok: faults.length === 0, faults, warnings, summary: formatSummaryTable(rows) };
}

function resolveContainerCli() {
  const requested = process.env.CONTAINER_CLI;
  if (requested) {
    if (!ALLOWED_CLIS.has(requested)) throw new Error(`CONTAINER_CLI must be docker or podman, got "${requested}"`);
    return requested;
  }
  for (const candidate of ALLOWED_CLIS) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try next container CLI candidate.
    }
  }
  throw new Error('Neither docker nor podman is available to query trixie-backports');
}

function buildContainerScript(spec) {
  const targets = [];
  for (const pkgSpec of spec.packages) {
    if (pkgSpec.archIndependent) {
      targets.push(pkgSpec.name);
      continue;
    }
    targets.push(`${pkgSpec.name}:amd64`, `${pkgSpec.name}:arm64`);
  }
  return [
    'set -eu',
    'native="$(dpkg --print-architecture)"',
    'if [ "$native" = "amd64" ]; then foreign=arm64; else foreign=amd64; fi',
    'dpkg --add-architecture "$foreign"',
    'printf "Types: deb\\nURIs: http://deb.debian.org/debian\\nSuites: trixie-backports\\nComponents: main\\nSigned-By: /usr/share/keyrings/debian-archive-keyring.pgp\\n" > /etc/apt/sources.list.d/debian-backports.sources',
    'printf "Package: src:libreoffice\\nPin: release n=trixie-backports\\nPin-Priority: 990\\n" > /etc/apt/preferences.d/libreoffice-backports',
    'apt-get -o Acquire::Retries=3 update -qq',
    'printf "__NATIVE_ARCH__=%s\\n" "$native"',
    `apt-cache policy ${targets.join(' ')} || true`,
  ].join('\n');
}

function runPolicyQuery(spec, cli) {
  const raw = execFileSync(cli, ['run', '--rm', spec.nodeImage, 'sh', '-ec', buildContainerScript(spec)], {
    encoding: 'utf8',
    timeout: CONTAINER_TIMEOUT_MS,
    maxBuffer: CONTAINER_MAX_BUFFER,
  });
  const marker = /^__NATIVE_ARCH__=(amd64|arm64)\r?\n/m.exec(raw);
  if (!marker) throw new Error('Container query did not report native dpkg architecture');
  return {
    nativeArch: marker[1],
    policyText: raw.slice(marker.index + marker[0].length),
  };
}

function emitResult(result) {
  process.stdout.write(result.summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.summary}\n`);
  }
  for (const warning of result.warnings) process.stdout.write(`::warning::${warning}\n`);
  for (const fault of result.faults) process.stderr.write(`::error::${fault}\n`);
  if (!result.ok) process.exitCode = 1;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile.worker'), 'utf8');
  const spec = readDockerfileBackportsSpec(dockerfile);
  const cli = resolveContainerCli();
  const { nativeArch, policyText } = runPolicyQuery(spec, cli);
  const parsed = parseAptCachePolicy(policyText, nativeArch);
  emitResult(checkBackportsPolicy(spec, parsed, nativeArch));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
