import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';

/**
 * Writes scripts/vtracer-notices/THIRD-PARTY-NOTICES, the licence texts of the Rust crates statically linked into the pinned vtracer
 * program (scripts/install-vtracer.sh installs it beside the program's own licence). It follows what the Rust tools that bundle licences
 * do (cargo-about, cargo-bundle-licenses) without building or running anything:
 * - the crates are the dependency graph of the program's package in the Cargo.lock of the tagged commit, where the workspace packages
 *   contribute only their normal and build dependencies (their development dependencies are in the lockfile too, but never linked);
 * - each crate's archive is the one crates.io serves, checked against the checksum the Cargo.lock records;
 * - only its LICENSE*, COPYING* and NOTICE* files, the file its `license-file` names and the licence fields of its Cargo.toml are read,
 *   with the system `tar`, as data;
 * - identical texts are written once, with the crates that ship them, and the Apache-2.0 text once more for the crates that offer it
 *   without shipping it.
 *
 * The upstream manifests are fetched from the tagged commit, checked against the digests below and kept in
 * scripts/vtracer-notices/upstream, so tests/worker-vtracer-packaging.test.ts can check the notices against the graph offline.
 *
 *   npx tsx scripts/generate-vtracer-notices.ts
 */

export const VTRACER_COMMIT = '2500df76b5aea0ac22d15296b22722442f825c5b';
/** The package of the `vtracer` binary in the upstream workspace. */
export const BINARY_PACKAGE = 'vtracer-cli';
export const NOTICES_DIR = path.resolve(__dirname, 'vtracer-notices');
export const NOTICES_FILE = path.join(NOTICES_DIR, 'THIRD-PARTY-NOTICES');
export const UPSTREAM_DIR = path.join(NOTICES_DIR, 'upstream');
/** Upstream files kept for the offline check, with a suffix so that no tool takes the directory for a Rust workspace. */
const PINNED_SUFFIX = '.pinned';
const LOCKFILE = 'Cargo.lock';
const ROOT_MANIFEST = 'Cargo.toml';
const BINARY_MANIFEST = 'crates/vtracer-cli/Cargo.toml';

/** SHA-256 of each upstream file at VTRACER_COMMIT. */
export const UPSTREAM_DIGESTS: Readonly<Record<string, string>> = {
  [LOCKFILE]: '4f3efd6128f0b4d3785655384bdddff5a26510b0603a42cd78ea9a4f9e5ecdae',
  [ROOT_MANIFEST]: '374454157e30248c8a65a07a217020075d65911b05574e95456dddc83f3f287d',
  [BINARY_MANIFEST]: 'd9b71a1babd7df83b5dc6c1b17c1cd9e001f8a5b5b3abb97e45641186dc9ceb1',
  'crates/vtracer/Cargo.toml': '42e7302dd7a27006737a14e085ae7714e005c80284aea9aba05d6176678d760e',
};
const APACHE_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0.txt';
const APACHE_LICENSE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const UPSTREAM_RAW_URL = `https://raw.githubusercontent.com/visioncortex/vtracer/${VTRACER_COMMIT}`;
const CRATE_URL = 'https://static.crates.io/crates';
const CRATES_IO_SOURCE = 'registry+https://github.com/rust-lang/crates.io-index';

/** The limits of scripts/third-party-notices.mjs, which gathers the npm notices the same way. */
const MAX_LICENSE_FILE_BYTES = 1024 * 1024;
const MAX_LICENSE_FILES_PER_PACKAGE = 16;
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
/** The largest crate archive crates.io accepts (its default upload limit is 10 MB), with room to spare. */
const MAX_CRATE_BYTES = 16 * 1024 * 1024;
const MAX_LOCK_PACKAGES = 5_000;
const MAX_TAR_LISTING_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const APACHE_TEXT = /Apache License\s+Version 2\.0/;
const APACHE_ID = /\bApache-2\.0\b/;
const RULE = '='.repeat(80);

export interface LockedPackage {
  readonly name: string;
  readonly version: string;
  readonly source?: string;
  readonly checksum?: string;
  readonly dependencies: readonly string[];
}

/** A crate of the program: a crates.io package of the graph. */
export interface LinkedCrate {
  readonly name: string;
  readonly version: string;
  readonly checksum: string;
}

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export function readPinned(file: string): string {
  return fs.readFileSync(path.join(UPSTREAM_DIR, `${file}${PINNED_SUFFIX}`), 'utf8');
}

export function parseLockfile(text: string): LockedPackage[] {
  const packages = (parse(text) as { package?: unknown[] }).package ?? [];
  if (packages.length > MAX_LOCK_PACKAGES) throw new Error(`the lockfile lists ${packages.length} packages, over ${MAX_LOCK_PACKAGES}`);
  return packages.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      name: String(record.name),
      version: String(record.version),
      source: record.source === undefined ? undefined : String(record.source),
      checksum: record.checksum === undefined ? undefined : String(record.checksum),
      dependencies: Array.isArray(record.dependencies) ? record.dependencies.map(String) : [],
    };
  });
}

type Manifest = Record<string, unknown>;
const LINKED_SECTIONS = ['dependencies', 'build-dependencies'] as const;

/** The names a workspace manifest depends on outside development, and the manifests of its path dependencies. */
function linkedDependencies(manifest: Manifest): { names: Set<string>; paths: string[] } {
  const tables: Record<string, unknown>[] = [];
  for (const section of LINKED_SECTIONS) tables.push((manifest[section] ?? {}) as Record<string, unknown>);
  for (const target of Object.values((manifest.target ?? {}) as Record<string, Manifest>)) {
    for (const section of LINKED_SECTIONS) tables.push((target[section] ?? {}) as Record<string, unknown>);
  }
  const names = new Set<string>();
  const paths: string[] = [];
  for (const table of tables) {
    for (const [key, spec] of Object.entries(table)) {
      const record = typeof spec === 'object' && spec !== null ? (spec as Record<string, unknown>) : {};
      names.add(typeof record.package === 'string' ? record.package : key);
      if (typeof record.path === 'string') paths.push(record.path);
    }
  }
  return { names, paths };
}

/** The lockfile entry a dependency line names: `name`, `name version` or `name version (source)`. */
function resolveEntry(packages: readonly LockedPackage[], line: string): LockedPackage {
  const [name, version] = line.split(' ');
  const found = packages.find((entry) => entry.name === name && (version === undefined || entry.version === version));
  if (found === undefined) throw new Error(`the lockfile has no package for the dependency "${line}"`);
  return found;
}

/**
 * The crates.io packages linked into the binary package: its lockfile graph, where a workspace package (no `source`) follows only the
 * dependencies its manifest lists outside development. `manifests` maps a workspace-relative manifest path to its parsed contents.
 */
export function linkedCrates(packages: readonly LockedPackage[], manifests: ReadonlyMap<string, Manifest>, binaryManifest: string): LinkedCrate[] {
  const workspaceAllowed = new Map<string, Set<string>>();
  const pending = [binaryManifest];
  while (pending.length > 0) {
    const manifestPath = pending.pop() as string;
    const manifest = manifests.get(manifestPath);
    if (manifest === undefined) throw new Error(`no manifest for ${manifestPath}`);
    const name = String((manifest.package as Record<string, unknown>).name);
    if (workspaceAllowed.has(name)) continue;
    const { names, paths } = linkedDependencies(manifest);
    workspaceAllowed.set(name, names);
    for (const relative of paths) pending.push(path.posix.join(path.posix.dirname(manifestPath), relative, 'Cargo.toml'));
  }
  const root = packages.find((entry) => entry.name === String((manifests.get(binaryManifest)?.package as Record<string, unknown>).name));
  if (root === undefined) throw new Error('the lockfile has no entry for the binary package');
  const seen = new Set<LockedPackage>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const entry = queue.shift() as LockedPackage;
    const allowed = entry.source === undefined ? workspaceAllowed.get(entry.name) : undefined;
    for (const line of entry.dependencies) {
      if (allowed !== undefined && !allowed.has(line.split(' ')[0])) continue;
      const next = resolveEntry(packages, line);
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen]
    .filter((entry) => entry.source !== undefined)
    .map((entry) => {
      if (entry.source !== CRATES_IO_SOURCE || entry.checksum === undefined) throw new Error(`${entry.name} ${entry.version} is not a crates.io package with a checksum`);
      return { name: entry.name, version: entry.version, checksum: entry.checksum };
    })
    .sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version, 'en') : a.name.localeCompare(b.name, 'en')));
}

/** The workspace manifests the binary package reaches, read from the pinned copies. */
export function pinnedManifests(): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  for (const file of Object.keys(UPSTREAM_DIGESTS)) {
    if (file !== LOCKFILE && file !== ROOT_MANIFEST) manifests.set(file, parse(readPinned(file)) as Manifest);
  }
  return manifests;
}

export function pinnedLinkedCrates(): LinkedCrate[] {
  return linkedCrates(parseLockfile(readPinned(LOCKFILE)), pinnedManifests(), BINARY_MANIFEST);
}

/** How the notices name a crate and its licence expression. */
const crateLine = (crate: Pick<LinkedCrate, 'name' | 'version'>, license: string): string => `${crate.name} ${crate.version} (${license})`;

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`${url} is ${bytes.length} bytes, over ${maxBytes}`);
  return bytes;
}

async function downloadChecked(url: string, digest: string, maxBytes: number): Promise<Buffer> {
  const bytes = await download(url, maxBytes);
  const actual = sha256(bytes);
  if (actual !== digest) throw new Error(`${url} has SHA-256 ${actual}, not the pinned ${digest}`);
  return bytes;
}

function tar(archive: Buffer, args: string[], maxBytes: number): Buffer {
  return execFileSync('tar', ['-xzO', '-f', '-', '--', ...args], { input: archive, maxBuffer: maxBytes });
}

function listMembers(archive: Buffer): string[] {
  const listing = execFileSync('tar', ['-tz', '-f', '-'], { input: archive, maxBuffer: MAX_TAR_LISTING_BYTES });
  return listing.toString('utf8').split('\n').filter(Boolean);
}

interface ProgramInfo {
  readonly version: string;
  readonly license: string;
}

interface CrateLicence {
  readonly crate: LinkedCrate;
  readonly license: string;
  readonly authors: readonly string[];
  readonly texts: ReadonlyArray<{ file: string; text: string }>;
}

async function crateLicence(crate: LinkedCrate): Promise<CrateLicence> {
  const archive = await downloadChecked(`${CRATE_URL}/${crate.name}/${crate.name}-${crate.version}.crate`, crate.checksum, MAX_CRATE_BYTES);
  const prefix = `${crate.name}-${crate.version}/`;
  const members = new Set(listMembers(archive));
  const manifest = parse(tar(archive, [`${prefix}Cargo.toml`], MAX_LICENSE_FILE_BYTES).toString('utf8')) as Manifest;
  const info = manifest.package as Record<string, unknown>;
  const licenseFile = typeof info['license-file'] === 'string' ? `${prefix}${info['license-file']}` : undefined;
  const files = [...members]
    .filter((member) => member === licenseFile || (member.startsWith(prefix) && LICENSE_FILE_PATTERN.test(member.slice(prefix.length))))
    .sort();
  if (files.length > MAX_LICENSE_FILES_PER_PACKAGE) throw new Error(`${prefix} ships ${files.length} licence files, over ${MAX_LICENSE_FILES_PER_PACKAGE}`);
  return {
    crate,
    license: typeof info.license === 'string' ? info.license : `see ${String(info['license-file'])}`,
    authors: Array.isArray(info.authors) ? info.authors.map(String) : [],
    texts: files.map((file) => ({ file: file.slice(prefix.length), text: tar(archive, [file], MAX_LICENSE_FILE_BYTES).toString('utf8') })),
  };
}

const withFinalNewline = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);

/** One block per distinct text, in the order of the first crate that ships it, naming every crate that ships the same text. */
function textBlocks(licences: readonly CrateLicence[]): string[] {
  const users = new Map<string, string[]>();
  for (const licence of licences) {
    for (const { file, text } of licence.texts) {
      const label = `${licence.crate.name} ${licence.crate.version} (${file})`;
      users.set(text, [...(users.get(text) ?? []), label]);
    }
  }
  return [...users].map(([text, labels]) => `${RULE}\nShipped by: ${labels.join(', ')}\n${RULE}\n${withFinalNewline(text)}`);
}

function render(licences: readonly CrateLicence[], program: ProgramInfo, apache: string): string {
  const withoutText = licences.filter((licence) => licence.texts.length === 0);
  const apacheFor = [
    `vtracer ${program.version}`,
    ...licences.filter((licence) => APACHE_ID.test(licence.license) && !licence.texts.some(({ text }) => APACHE_TEXT.test(text))).map((licence) => `${licence.crate.name} ${licence.crate.version}`),
  ];
  return [
    `vtracer ${program.version}: third-party notices`,
    '',
    `The vtracer program (${program.license}) is statically linked with Rust crates. The crates below are the dependency graph of its`,
    `package ${BINARY_PACKAGE} in the Cargo.lock of commit ${VTRACER_COMMIT}`,
    `(SHA-256 ${UPSTREAM_DIGESTS[LOCKFILE]}), without development dependencies. The lockfile does`,
    'not tell apart the crates used only to build the program (procedural macros) or only on other platforms, so they are named too.',
    'Each text below is copied unmodified from the crates.io archive of the crates named above it, checked against the Cargo.lock',
    'checksum. Generated by scripts/generate-vtracer-notices.ts.',
    '',
    `Crates (${licences.length}):`,
    ...licences.map((licence) => crateLine(licence.crate, licence.license)),
    '',
    ...(withoutText.length === 0
      ? []
      : ['Crates whose archive ships no licence text, with the authors their manifest names:', ...withoutText.map((licence) => `${crateLine(licence.crate, licence.license)}: ${licence.authors.join('; ') || 'no authors listed'}`), '']),
    ...textBlocks(licences),
    `${RULE}\nApache License 2.0, the text offered without a copy by: ${apacheFor.join(', ')}\n${RULE}\n${withFinalNewline(apache)}`,
  ].join('\n');
}

async function fetchUpstream(): Promise<void> {
  for (const [file, digest] of Object.entries(UPSTREAM_DIGESTS)) {
    const bytes = await downloadChecked(`${UPSTREAM_RAW_URL}/${file}`, digest, MAX_CRATE_BYTES);
    const target = path.join(UPSTREAM_DIR, `${file}${PINNED_SUFFIX}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}

async function main(): Promise<void> {
  await fetchUpstream();
  const workspacePackage = ((parse(readPinned(ROOT_MANIFEST)) as Manifest).workspace as Record<string, Record<string, unknown>>).package;
  const program = { version: String(workspacePackage.version), license: String(workspacePackage.license) };
  const licences: CrateLicence[] = [];
  for (const crate of pinnedLinkedCrates()) licences.push(await crateLicence(crate));
  const apache = (await downloadChecked(APACHE_LICENSE_URL, APACHE_LICENSE_SHA256, MAX_LICENSE_FILE_BYTES)).toString('utf8');
  fs.writeFileSync(NOTICES_FILE, render(licences, program, apache), 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), NOTICES_FILE)}: ${licences.length} crates, SHA-256 ${sha256(fs.readFileSync(NOTICES_FILE))}`);
}

if (process.argv[1]?.endsWith('generate-vtracer-notices.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
