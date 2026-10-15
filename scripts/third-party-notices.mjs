#!/usr/bin/env node
/**
 * Generates THIRD_PARTY_NOTICES.md from package-lock.json and gates production dependency licences.
 *
 *   node scripts/third-party-notices.mjs           write the notices file
 *   node scripts/third-party-notices.mjs --check   compare with the committed file, exit 1 on drift
 *
 * Optional flags (used by the tests to run against fixtures): --lockfile, --allow, --output, --node-modules.
 *
 * Exit codes: 0 ok, 1 policy failure or drift, 2 malformed input (typed error on stderr).
 *
 * Determinism: the package set, versions and licences come only from the lockfile (lockfileVersion 3), never
 * from `npm ls` or the installed tree. Licence text is embedded only for non-optional packages, which every
 * host installs with identical contents; optional (platform) packages are listed without text so the output
 * does not depend on the host. Sorting uses code-unit order, not the locale.
 */
import node_fs from 'node:fs';
import node_path from 'node:path';
import node_url from 'node:url';

const EXIT_OK = 0;
const EXIT_POLICY_FAILURE = 1;
const EXIT_MALFORMED_INPUT = 2;

const SUPPORTED_LOCKFILE_VERSION = 3;
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const MAX_ALLOWLIST_BYTES = 1024 * 1024;
const MAX_PACKAGES = 20_000;
const MAX_ALLOWED_LICENSES = 500;
const MAX_EXCEPTIONS = 1_000;
const MAX_LICENSE_FILE_BYTES = 1024 * 1024;
const MAX_LICENSE_FILES_PER_PACKAGE = 16;
const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SPDX_LENGTH = 1_024;
const MAX_SPDX_TOKENS = 256;
const MAX_SPDX_DEPTH = 16;
const MAX_SUMMARY_ITEMS = 20;

const NODE_MODULES_SEGMENT = 'node_modules/';
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
const PACKAGE_NAME_PATTERN = /^(@[^/@\s]+\/)?[^/@\s]+$/;
const EXCEPTION_KEY_PATTERN = /^((?:@[^/@\s]+\/)?[^/@\s]+)@([^@\s]+)$/;
const SPDX_TOKEN_PATTERN = /\(|\)|[A-Za-z0-9][A-Za-z0-9.+-]*/y;
const BOM = '﻿';
const MIN_FENCE_LENGTH = 3;
const FENCE_LINE_PATTERN = /^(`{3,})/;
const HEADING_PATTERN = /^### (.+)$/;

/** LGPL-3.0 is allowed only for the dynamically loaded libvips binaries; see docs/licensing.md. */
const LGPL3_FAMILY = new Set(['LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later']);
const SPDX_KEYWORDS = new Set(['AND', 'OR', 'WITH']);

const OPTIONAL_TEXT_NOTE =
  'Licence text: not embedded (optional platform package that is not installed on every host); the full text ships in the package.';
const NO_FILE_TEXT_NOTE = 'Licence text: the package ships no LICENSE, COPYING or NOTICE file.';

class NoticesError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}
class UsageError extends NoticesError {}
class LockfileError extends NoticesError {}
class AllowlistError extends NoticesError {}
class InstallError extends NoticesError {}
class SpdxError extends NoticesError {}

function compareCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---------------------------------------------------------------------------------------------------------
// CLI

const VALUE_FLAGS = new Map([
  ['--lockfile', 'lockfile'],
  ['--allow', 'allow'],
  ['--output', 'output'],
  ['--node-modules', 'nodeModules'],
]);

function parseArgs(argv) {
  const root = node_path.resolve(node_path.dirname(node_url.fileURLToPath(import.meta.url)), '..');
  const options = {
    check: false,
    lockfile: node_path.join(root, 'package-lock.json'),
    allow: node_path.join(root, 'licenses.allow.json'),
    output: node_path.join(root, 'THIRD_PARTY_NOTICES.md'),
    nodeModules: node_path.join(root, 'node_modules'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    const key = VALUE_FLAGS.get(arg);
    if (key === undefined) throw new UsageError(`unknown argument "${arg}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a path`);
    options[key] = node_path.resolve(value);
    i += 1;
  }
  return options;
}

// ---------------------------------------------------------------------------------------------------------
// Inputs

function readBoundedJson(file, maxBytes, ErrorType, label) {
  let size;
  try {
    size = node_fs.statSync(file).size;
  } catch (err) {
    throw new ErrorType(`cannot read ${label} ${file}: ${err.message}`);
  }
  if (size > maxBytes) throw new ErrorType(`${label} is larger than ${maxBytes} bytes`);
  try {
    return JSON.parse(node_fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ErrorType(`${label} ${file} is not valid JSON: ${err.message}`);
  }
}

/** Production packages from the lockfile: every entry except the root and `dev: true`, deduplicated by name@version. */
function readProductionPackages(lockfilePath) {
  const lock = readBoundedJson(lockfilePath, MAX_LOCKFILE_BYTES, LockfileError, 'lockfile');
  if (lock === null || typeof lock !== 'object' || lock.lockfileVersion !== SUPPORTED_LOCKFILE_VERSION) {
    throw new LockfileError(`only lockfileVersion ${SUPPORTED_LOCKFILE_VERSION} is supported`);
  }
  if (lock.packages === null || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new LockfileError('lockfile has no "packages" object');
  }
  const entries = Object.entries(lock.packages);
  if (entries.length > MAX_PACKAGES) throw new LockfileError(`lockfile lists more than ${MAX_PACKAGES} packages`);

  const byId = new Map();
  for (const [key, entry] of entries) {
    if (key === '') continue;
    if (entry === null || typeof entry !== 'object') throw new LockfileError(`entry "${key}" is not an object`);
    if (entry.dev === true || entry.link === true) continue;
    if (!key.startsWith(NODE_MODULES_SEGMENT)) {
      throw new LockfileError(`entry "${key}" is outside node_modules; workspaces are not supported`);
    }
    const name = key.slice(key.lastIndexOf(NODE_MODULES_SEGMENT) + NODE_MODULES_SEGMENT.length);
    if (!PACKAGE_NAME_PATTERN.test(name)) throw new LockfileError(`entry "${key}" has an invalid package name`);
    if (typeof entry.version !== 'string' || entry.version === '') throw new LockfileError(`entry "${key}" has no version`);

    const license = typeof entry.license === 'string' && entry.license.trim() !== '' ? entry.license.trim() : null;
    const optional = entry.optional === true || entry.devOptional === true;
    const resolved = typeof entry.resolved === 'string' ? entry.resolved : '';
    const id = `${name}@${entry.version}`;
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, { id, name, version: entry.version, license, optional, resolved, keys: [key] });
      continue;
    }
    if (existing.license !== license) throw new LockfileError(`${id} appears with different licences in the lockfile`);
    existing.optional = existing.optional && optional;
    existing.keys.push(key);
  }
  return [...byId.values()].sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.version, b.version));
}

function readAllowlist(allowPath) {
  const raw = readBoundedJson(allowPath, MAX_ALLOWLIST_BYTES, AllowlistError, 'allowlist');
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.allowed)) {
    throw new AllowlistError('allowlist needs an "allowed" array');
  }
  if (raw.allowed.length > MAX_ALLOWED_LICENSES) throw new AllowlistError('allowlist has too many licences');
  for (const lic of raw.allowed) {
    if (typeof lic !== 'string' || lic.trim() === '') throw new AllowlistError('"allowed" must hold non-empty strings');
  }
  const rawExceptions = raw.exceptions ?? {};
  if (rawExceptions === null || typeof rawExceptions !== 'object' || Array.isArray(rawExceptions)) {
    throw new AllowlistError('"exceptions" must be an object keyed by name@version');
  }
  const keys = Object.keys(rawExceptions);
  if (keys.length > MAX_EXCEPTIONS) throw new AllowlistError('allowlist has too many exceptions');
  const exceptions = new Map();
  for (const key of keys) {
    const value = rawExceptions[key];
    if (!EXCEPTION_KEY_PATTERN.test(key)) throw new AllowlistError(`exception key "${key}" must be an exact name@version`);
    if (value === null || typeof value !== 'object' || typeof value.reason !== 'string' || value.reason.trim() === '') {
      throw new AllowlistError(`exception "${key}" needs a non-empty reason`);
    }
    if (value.license !== undefined && (typeof value.license !== 'string' || value.license.trim() === '')) {
      throw new AllowlistError(`exception "${key}" has an invalid licence`);
    }
    exceptions.set(key, { license: value.license?.trim() ?? null, reason: value.reason.trim() });
  }
  return { allowed: new Set(raw.allowed), exceptions };
}

// ---------------------------------------------------------------------------------------------------------
// SPDX expression evaluation: `OR` passes when any branch passes, `AND` only when every part passes.

function tokenizeSpdx(expression) {
  if (expression.length > MAX_SPDX_LENGTH) throw new SpdxError('expression is too long');
  const tokens = [];
  let pos = 0;
  while (pos < expression.length) {
    if (/\s/.test(expression[pos])) {
      pos += 1;
      continue;
    }
    SPDX_TOKEN_PATTERN.lastIndex = pos;
    const match = SPDX_TOKEN_PATTERN.exec(expression);
    if (match === null) throw new SpdxError(`unexpected character "${expression[pos]}"`);
    tokens.push(match[0]);
    if (tokens.length > MAX_SPDX_TOKENS) throw new SpdxError('expression has too many tokens');
    pos += match[0].length;
  }
  return tokens;
}

function isAtomAllowed(id, allowed) {
  if (allowed.has(id)) return true;
  return allowed.has('LGPL-3.0') && LGPL3_FAMILY.has(id);
}

/** Recursive descent over: or := and ('OR' and)*, and := atom ('AND' atom)*, atom := '(' or ')' | id ['WITH' id]. */
function evaluateSpdx(expression, allowed) {
  const tokens = tokenizeSpdx(expression);
  let index = 0;

  const peek = () => tokens[index];
  const isId = (token) => token !== undefined && token !== '(' && token !== ')' && !SPDX_KEYWORDS.has(token);

  function parseAtom(depth) {
    if (depth > MAX_SPDX_DEPTH) throw new SpdxError('expression is nested too deeply');
    const token = tokens[index];
    if (token === '(') {
      index += 1;
      const value = parseOr(depth + 1);
      if (tokens[index] !== ')') throw new SpdxError('missing ")"');
      index += 1;
      return value;
    }
    if (!isId(token)) throw new SpdxError(`expected a licence identifier, found ${token === undefined ? 'end of input' : `"${token}"`}`);
    index += 1;
    if (peek() === 'WITH') {
      index += 1;
      const exception = tokens[index];
      if (!isId(exception)) throw new SpdxError('WITH needs an exception identifier');
      index += 1;
      return allowed.has(`${token} WITH ${exception}`);
    }
    return isAtomAllowed(token, allowed);
  }

  function parseAnd(depth) {
    let value = parseAtom(depth);
    while (peek() === 'AND') {
      index += 1;
      const next = parseAtom(depth);
      value = value && next;
    }
    return value;
  }

  function parseOr(depth) {
    let value = parseAnd(depth);
    while (peek() === 'OR') {
      index += 1;
      const next = parseAnd(depth);
      value = value || next;
    }
    return value;
  }

  const result = parseOr(0);
  if (index !== tokens.length) throw new SpdxError(`unexpected "${tokens[index]}"`);
  return result;
}

/** Resolves each package's effective licence and collects every policy failure, sorted for stable output. */
function evaluatePolicy(packages, allowlist) {
  const failures = [];
  const ids = new Set(packages.map((pkg) => pkg.id));
  for (const pkg of packages) {
    const exception = allowlist.exceptions.get(pkg.id);
    if (exception !== undefined) {
      if (pkg.license === null && exception.license === null) {
        failures.push(`${pkg.id}: no licence in the lockfile entry and the exception does not name one`);
      } else if (pkg.license !== null && exception.license !== null && pkg.license !== exception.license) {
        failures.push(`${pkg.id}: exception names "${exception.license}" but the lockfile says "${pkg.license}"`);
      }
      pkg.effectiveLicense = pkg.license ?? exception.license;
      continue;
    }
    pkg.effectiveLicense = pkg.license;
    if (pkg.license === null) {
      failures.push(`${pkg.id}: no licence in the lockfile entry and no exception in licenses.allow.json`);
      continue;
    }
    try {
      if (!evaluateSpdx(pkg.license, allowlist.allowed)) failures.push(`${pkg.id}: ${pkg.license} (not allowed)`);
    } catch (err) {
      if (!(err instanceof SpdxError)) throw err;
      failures.push(`${pkg.id}: unparseable licence "${pkg.license}" (${err.message})`);
    }
  }
  for (const key of allowlist.exceptions.keys()) {
    if (!ids.has(key)) failures.push(`stale exception ${key}: no such production package in the lockfile`);
  }
  return failures.sort(compareCodeUnits);
}

// ---------------------------------------------------------------------------------------------------------
// Installed package contents (non-optional packages only)

function readInstalledMetadata(pkg, nodeModulesDir) {
  let installDir = null;
  for (const key of [...pkg.keys].sort(compareCodeUnits)) {
    const candidate = node_path.join(nodeModulesDir, key.slice(NODE_MODULES_SEGMENT.length));
    if (node_fs.existsSync(node_path.join(candidate, 'package.json'))) {
      installDir = candidate;
      break;
    }
  }
  if (installDir === null) throw new InstallError(`${pkg.id} is not installed under ${nodeModulesDir}; run "npm ci" first`);

  const manifestPath = node_path.join(installDir, 'package.json');
  if (node_fs.statSync(manifestPath).size > MAX_PACKAGE_JSON_BYTES) throw new InstallError(`${pkg.id}: package.json is too large`);
  let manifest;
  try {
    manifest = JSON.parse(node_fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new InstallError(`${pkg.id}: package.json is not valid JSON: ${err.message}`);
  }
  if (manifest.version !== pkg.version) {
    throw new InstallError(`${pkg.id}: installed version is ${String(manifest.version)}; run "npm ci" first`);
  }

  let repository = '';
  if (typeof manifest.repository === 'string') repository = manifest.repository;
  else if (manifest.repository !== null && typeof manifest.repository === 'object' && typeof manifest.repository.url === 'string') {
    repository = manifest.repository.url;
  }

  const fileNames = node_fs
    .readdirSync(installDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareCodeUnits);
  if (fileNames.length > MAX_LICENSE_FILES_PER_PACKAGE) throw new InstallError(`${pkg.id}: more than ${MAX_LICENSE_FILES_PER_PACKAGE} licence files`);

  const files = fileNames.map((fileName) => {
    const filePath = node_path.join(installDir, fileName);
    if (node_fs.statSync(filePath).size > MAX_LICENSE_FILE_BYTES) throw new InstallError(`${pkg.id}: ${fileName} is larger than ${MAX_LICENSE_FILE_BYTES} bytes`);
    const decoded = node_fs.readFileSync(filePath, 'utf8');
    const text = (decoded.startsWith(BOM) ? decoded.slice(BOM.length) : decoded).replace(/\r\n?/g, '\n').trimEnd();
    return { fileName, text };
  });
  return { repository: repository.replace(/\s+/g, ' ').trim(), files };
}

// ---------------------------------------------------------------------------------------------------------
// Rendering

/** A fence longer than any backtick run in the text, so licence text cannot close it early. */
function fenceFor(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(MIN_FENCE_LENGTH, longest + 1));
}

function renderSection(pkg, nodeModulesDir) {
  const lines = [`### ${pkg.id}`, '', `- **License**: \`${pkg.effectiveLicense}\``];
  if (pkg.resolved !== '') lines.push(`- **Source**: ${pkg.resolved}`);
  if (pkg.optional) {
    lines.push('', OPTIONAL_TEXT_NOTE);
  } else {
    const installed = readInstalledMetadata(pkg, nodeModulesDir);
    if (installed.repository !== '') lines.push(`- **Repository**: ${installed.repository}`);
    if (installed.files.length === 0) lines.push('', NO_FILE_TEXT_NOTE);
    for (const file of installed.files) {
      const fence = fenceFor(file.text);
      lines.push('', `#### ${file.fileName}`, '', `${fence}text`, file.text, fence);
    }
  }
  lines.push('', '---', '');
  return lines.join('\n');
}

function renderNotices(packages, nodeModulesDir) {
  const header = [
    '# Third-Party Software Notices',
    '',
    'This file lists the production npm packages of EasyConvert, taken from `package-lock.json`, with their licences.',
    'It is generated by `npm run licenses:generate` and verified by `npm run licenses:check`; do not edit it by hand.',
    'Full licence text is embedded for every non-optional package. Optional platform packages (for example the',
    'prebuilt image-processing and rendering binaries) are listed without text because they are installed only on',
    'matching hosts; their licence files and bundled library notices ship in the package itself.',
    '',
    `Total packages: ${packages.length}`,
    '',
    '---',
    '',
    '',
  ].join('\n');
  return header + packages.map((pkg) => renderSection(pkg, nodeModulesDir)).join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// Drift summary

/** Splits a notices file into `### name@version` sections, ignoring headings inside code fences. */
function splitSections(markdown) {
  const sections = new Map();
  let currentId = null;
  let buffer = [];
  let fenceLength = 0;
  const flush = () => {
    if (currentId !== null) sections.set(currentId, buffer.join('\n'));
  };
  for (const line of markdown.split('\n')) {
    const fence = FENCE_LINE_PATTERN.exec(line);
    if (fenceLength === 0 && fence) fenceLength = fence[1].length;
    else if (fenceLength > 0 && fence && fence[1].length >= fenceLength && line.trim() === fence[1]) fenceLength = 0;
    const heading = fenceLength === 0 ? HEADING_PATTERN.exec(line) : null;
    if (heading) {
      flush();
      currentId = heading[1];
      buffer = [];
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

function summariseDrift(committed, generated) {
  const before = splitSections(committed);
  const after = splitSections(generated);
  const items = [];
  for (const id of [...after.keys()].sort(compareCodeUnits)) {
    if (!before.has(id)) items.push(`added: ${id}`);
    else if (before.get(id) !== after.get(id)) items.push(`changed: ${id}`);
  }
  for (const id of [...before.keys()].sort(compareCodeUnits)) {
    if (!after.has(id)) items.push(`removed: ${id}`);
  }
  if (items.length === 0) items.push('changed: file header or layout');
  const shown = items.slice(0, MAX_SUMMARY_ITEMS);
  if (items.length > shown.length) shown.push(`... and ${items.length - shown.length} more`);
  return shown;
}

// ---------------------------------------------------------------------------------------------------------

function run(argv) {
  const options = parseArgs(argv);
  const packages = readProductionPackages(options.lockfile);
  const allowlist = readAllowlist(options.allow);

  const failures = evaluatePolicy(packages, allowlist);
  if (failures.length > 0) {
    console.error(`Licence policy failed (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    return EXIT_POLICY_FAILURE;
  }

  const generated = renderNotices(packages, options.nodeModules);
  const label = node_path.basename(options.output);
  if (!options.check) {
    node_fs.writeFileSync(options.output, generated, 'utf8');
    console.log(`Wrote ${label} (${packages.length} packages).`);
    return EXIT_OK;
  }

  if (!node_fs.existsSync(options.output)) {
    console.error(`${label} does not exist; run "npm run licenses:generate".`);
    return EXIT_POLICY_FAILURE;
  }
  const committed = node_fs.readFileSync(options.output, 'utf8');
  if (committed !== generated) {
    console.error(`${label} is out of date; run "npm run licenses:generate" and commit the result.`);
    for (const item of summariseDrift(committed, generated)) console.error(`  ${item}`);
    return EXIT_POLICY_FAILURE;
  }
  console.log(`Licence check passed: ${label} is current (${packages.length} packages).`);
  return EXIT_OK;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof NoticesError)) throw err;
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = EXIT_MALFORMED_INPUT;
}
