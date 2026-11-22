import fs from 'node:fs';
import path from 'node:path';
import {
  block,
  type CrateLicence,
  downloadChecked,
  LICENSE_FILE_PATTERN,
  listMembers,
  MAX_LICENSE_FILE_BYTES,
  MAX_LICENSE_FILES_PER_PACKAGE,
  readMember,
  sha256,
  textBlocks,
} from './generate-vtracer-notices';

/**
 * Writes scripts/pandoc-notices/THIRD-PARTY-NOTICES, the licence texts of the third-party code statically linked into the pinned pandoc
 * release programs (scripts/install-pandoc.sh installs it beside the program's own copyright notice). It does for pandoc's Haskell packages
 * what scripts/generate-vtracer-notices.ts does for Rust crates:
 * - the packages are listed in scripts/pandoc-notices/packages.lock with the SHA-256 of the Hackage source archive of each, and nothing
 *   else is built or run. The release programs are built with `cabal build` in a container and the repository ships no freeze file, so the
 *   list is read from the programs themselves: both carry the unit id of each package they link (`<package>-<version>-<hash>`), and
 *   `--verify-binary <pandoc>` prints them again for comparison with the lock. A package whose code is linked but leaves no unit id is
 *   added when a package of the list requires it outside any `if` of its library stanza (origin `plan`, at the Stackage LTS 22.0 version, the
 *   snapshot of GHC 9.6.3 that the versions of the programs match); this generator stops at a package of the list that requires another one
 *   the lock does not name;
 * - each archive is checked against the digest of the lock, and only its LICENSE*, COPYING* and NOTICE* files, the files its `.cabal` names
 *   as `license-file`(s) and the licence texts of the C libraries it bundles (BUNDLED_TEXTS) are read, with the system `tar`, as data; an empty
 *   text, a member that is not a regular file and a package without a text stop it;
 * - identical texts are written once, with the packages that ship them.
 *
 * The C libraries and the compiler runtime that no Haskell package ships are pinned below: the GHC 9.6.3 licence (it covers the runtime
 * system), musl libc, GNU MP, zlib, libffi and the GCC runtime library, from the Alpine image that builds the programs (Makefile of the tagged
 * commit, `make debpkg`; the programs carry `GCC: (Alpine 12.2.1_git20220924-r10)`, `inflate 1.2.13` and `Lua 5.4.4`). Lua and libyaml are
 * bundled by the packages `lua` and `libyaml`.
 *
 *   npx tsx scripts/generate-pandoc-notices.ts
 *   npx tsx scripts/generate-pandoc-notices.ts --verify-binary path/to/pandoc
 */

export const PANDOC_VERSION = '3.1.11';
/** The commit that tag 3.1.11 names. */
export const PANDOC_COMMIT = 'c3038dcd54152c4e18e49db31676b79ee7cc29b2';
export const NOTICES_DIR = path.resolve(__dirname, 'pandoc-notices');
export const NOTICES_FILE = path.join(NOTICES_DIR, 'THIRD-PARTY-NOTICES');
export const LOCK_FILE = path.join(NOTICES_DIR, 'packages.lock');
export const HACKAGE_URL = 'https://hackage.haskell.org/package';
/** The largest source archive of the list is under 2 MB. */
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
export const MAX_TOOLCHAIN_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const ORIGINS = ['binary', 'plan', 'ghc'] as const;

export interface LockedPackage {
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
  readonly origin: (typeof ORIGINS)[number];
}

const LOCK_LINE = /^([A-Za-z][A-Za-z0-9-]*) (\d+(?:\.\d+)*) ([0-9a-f]{64}) (binary|plan|ghc)$/;

export function parseLock(text: string): LockedPackage[] {
  const packages = text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const match = LOCK_LINE.exec(line);
      if (match === null) throw new Error(`packages.lock has a line that is not "<package> <version> <sha256> <origin>": ${line}`);
      return { name: match[1], version: match[2], sha256: match[3], origin: match[4] as LockedPackage['origin'] };
    });
  const names = packages.map((entry) => entry.name);
  if (new Set(names).size !== names.length) throw new Error('packages.lock names a package twice');
  if (names.some((name, index) => index > 0 && names[index - 1] >= name)) throw new Error('packages.lock is not sorted by package name (by code point)');
  return packages;
}

export const readLock = (): LockedPackage[] => parseLock(fs.readFileSync(LOCK_FILE, 'utf8'));

/** Libraries of GHC itself, whose unit ids carry no hash. */
const GHC_LIBRARIES = ['array', 'binary', 'bytestring', 'containers', 'deepseq', 'directory', 'exceptions', 'filepath', 'ghc-boot-th', 'integer-gmp', 'mtl', 'parsec', 'pretty', 'process', 'stm', 'text', 'time', 'transformers', 'unix'];
const HASHED_UNIT_ID = /(?<![A-Za-z0-9-])([a-z][A-Za-z0-9-]*)-(\d+(?:\.\d+)*)-[0-9a-f]{64}(?![0-9a-f])/g;
const GHC_UNIT_ID = new RegExp(`(?<![A-Za-z0-9.-])(${GHC_LIBRARIES.join('|')})-(\\d+(?:\\.\\d+)*)(?![A-Za-z0-9.-])`, 'g');

/** The `<package> <version>` of every unit id in a release program (read as latin1 text, so a byte is a character). */
export function binaryPackages(program: Buffer): string[] {
  const text = program.toString('latin1');
  const found = new Set<string>();
  for (const pattern of [HASHED_UNIT_ID, GHC_UNIT_ID]) {
    for (const [, name, version] of text.matchAll(pattern)) found.add(`${name} ${version}`);
  }
  return [...found].sort();
}

/**
 * The packages the library of a package requires outside any `if`/`else` of its stanza (and of the `common` stanzas it imports), by name.
 * The package's own sublibraries are not requirements.
 */
export function libraryDependencies(cabal: string, own: string): Set<string> {
  const stanzas = cabal.replaceAll('\r', '').replace(/^[ \t]*--.*$/gm, '').split(/^(?=\S)/m);
  const commons = new Map<string, string>();
  const libraries: string[] = [];
  const sublibraries = new Set<string>([own]);
  for (const stanza of stanzas) {
    const match = /^(library|common)[ \t]*(\S*)/.exec(stanza);
    if (match === null) continue;
    if (match[1] === 'common') commons.set(match[2], stanza);
    else if (match[2] === '' || match[2] === own) libraries.push(stanza);
    else sublibraries.add(match[2]);
  }
  const names = new Set<string>();
  const scan = (stanza: string): void => {
    const lines = stanza.split('\n');
    const open: number[] = [];
    for (let at = 0; at < lines.length; at++) {
      const line = lines[at];
      const indent = line.length - line.trimStart().length;
      if (line.trim() !== '') {
        while (open.length > 0 && indent <= open[open.length - 1]) open.pop();
        if (/^\s*(if|elif|else)\b/.test(line)) open.push(indent);
      }
      const field = /^(\s+)build-depends[ \t]*:(.*)$/i.exec(line);
      if (field === null) continue;
      let list = field[2];
      while (at + 1 < lines.length && (lines[at + 1].trim() === '' || lines[at + 1].length - lines[at + 1].trimStart().length > field[1].length)) list += `\n${lines[++at]}`;
      if (open.length > 0) continue;
      for (const item of list.split(/[,\n]/)) {
        const name = /^\s*([A-Za-z][A-Za-z0-9-]*)/.exec(item)?.[1];
        if (name !== undefined) names.add(name);
      }
    }
  };
  for (const library of libraries) {
    scan(library);
    for (const [, imports] of library.matchAll(/^[ \t]+import[ \t]*:[ \t]*(.+)$/gm)) {
      for (const common of imports.split(/[,\s]+/)) if (commons.has(common)) scan(commons.get(common) as string);
    }
  }
  for (const name of sublibraries) names.delete(name);
  return names;
}

/** Licence texts that a package bundles beside the code of a C library, outside the root of its archive, by package name. */
const BUNDLED_TEXTS: Readonly<Record<string, readonly string[]>> = {
  digest: ['external/crc32c/LICENSE'],
  libyaml: ['libyaml_src/LICENSE'],
};

export type PackageLicence = CrateLicence;

const cabalOf = (name: string): string => `${name}.cabal`;

export const archiveUrl = (entry: { readonly name: string; readonly version: string }): string => `${HACKAGE_URL}/${entry.name}-${entry.version}/${entry.name}-${entry.version}.tar.gz`;

/** The `.cabal` file of a Hackage source archive. */
export function readCabal(entry: { readonly name: string; readonly version: string }, archive: Buffer): string {
  return readMember(archive, `${entry.name}-${entry.version}/${cabalOf(entry.name)}`, MAX_LICENSE_FILE_BYTES, 'z');
}

/** The licence fields and texts of a package, read from its Hackage source archive as data. */
export function readPackageLicence(entry: { readonly name: string; readonly version: string }, archive: Buffer): PackageLicence {
  const prefix = `${entry.name}-${entry.version}/`;
  const bundled = (BUNDLED_TEXTS[entry.name] ?? []).map((file) => `${prefix}${file}`);
  const members = listMembers(archive, 'z', [prefix.slice(0, -1), ...bundled]);
  const cabal = readCabal(entry, archive);
  const license = /^license[ \t]*:[ \t]*(\S.*?)[ \t]*$/im.exec(cabal)?.[1];
  if (license === undefined) throw new Error(`${prefix}${cabalOf(entry.name)} has no license field`);
  const named = [...cabal.matchAll(/^license-files?[ \t]*:[ \t]*(\S.*?)[ \t]*$/gim)].flatMap(([, value]) => value.split(/[,\s]+/)).map((file) => `${prefix}${file}`);
  const files = [...members.keys()]
    .filter((member) => named.includes(member) || bundled.includes(member) || (member.startsWith(prefix) && LICENSE_FILE_PATTERN.test(member.slice(prefix.length))))
    .sort()
    .map((member) => ({ member, label: member.slice(prefix.length) }));
  if (files.length > MAX_LICENSE_FILES_PER_PACKAGE) throw new Error(`${prefix} ships ${files.length} licence files, over ${MAX_LICENSE_FILES_PER_PACKAGE}`);
  const texts = files.map(({ member, label }) => {
    if (!members.get(member)) throw new Error(`${member} is not a regular file`);
    const text = readMember(archive, member, MAX_LICENSE_FILE_BYTES, 'z');
    if (text.trim() === '') throw new Error(`${member} is empty`);
    return { file: label, text };
  });
  if (texts.length === 0) throw new Error(`${entry.name} ${entry.version} ships no licence text`);
  return { crate: { name: entry.name, version: entry.version }, license, authors: [], texts };
}

const GCC_RAW_URL = 'https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-12.2.0';

interface PinnedFile {
  readonly url: string;
  readonly sha256: string;
}

/** A pinned text of the compiler runtime or of a C library the programs link: a file of a repository, or members of a source archive. */
export interface ToolchainText {
  readonly heading: string;
  readonly source: PinnedFile & { readonly compression?: 'z' | 'J'; readonly members?: readonly string[] };
}

export const TOOLCHAIN_TEXTS: readonly ToolchainText[] = [
  {
    heading: 'GHC 9.6.3 (BSD-3-Clause), the compiler and the runtime system its programs carry: LICENSE at tag ghc-9.6.3-release',
    source: { url: 'https://raw.githubusercontent.com/ghc/ghc/ghc-9.6.3-release/LICENSE', sha256: 'e06c13b8a117652621781c15d622bd4c62c568307954f7136955b4b656d14ec1' },
  },
  {
    heading: 'musl libc (MIT), the C library of the Alpine build image, linked statically: COPYRIGHT at tag v1.2.5, the same file as in the releases 1.2.3 and 1.2.4',
    source: { url: 'https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT?h=v1.2.5', sha256: 'f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af' },
  },
  {
    heading: 'GNU MP (LGPL-3.0-or-later or GPL-2.0-or-later), the big-number library of ghc-bignum, linked statically: README, COPYINGv2 and COPYING.LESSERv3 of gmp 6.2.1',
    source: {
      url: 'https://ftp.gnu.org/gnu/gmp/gmp-6.2.1.tar.xz',
      sha256: 'fd4829912cddd12f84181c3451cc752be224643e87fac497b69edddadc49b4f2',
      compression: 'J',
      members: ['gmp-6.2.1/README', 'gmp-6.2.1/COPYINGv2', 'gmp-6.2.1/COPYING.LESSERv3'],
    },
  },
  {
    heading: 'zlib 1.2.13 (Zlib), linked statically (the programs carry "inflate 1.2.13"): LICENSE',
    source: { url: 'https://zlib.net/fossils/zlib-1.2.13.tar.gz', sha256: 'b3a24de97a8fdbc835b9833169501030b8977031bcb54b3b3ac13740f846ab30', compression: 'z', members: ['zlib-1.2.13/LICENSE'] },
  },
  {
    heading: 'libffi (MIT), which the GHC runtime system uses for foreign calls, linked statically: LICENSE at tag v3.4.4',
    source: { url: 'https://raw.githubusercontent.com/libffi/libffi/v3.4.4/LICENSE', sha256: '2c9c2acb9743e6b007b91350475308aee44691d96aa20eacef8e199988c8c388' },
  },
  {
    heading: 'GCC runtime library (GPL-3.0-or-later WITH GCC-exception-3.1), libgcc of GCC 12.2.1: COPYING3 at tag releases/gcc-12.2.0',
    source: { url: `${GCC_RAW_URL}/COPYING3`, sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903' },
  },
  {
    heading: 'GCC runtime library exception 3.1: COPYING.RUNTIME at tag releases/gcc-12.2.0',
    source: { url: `${GCC_RAW_URL}/COPYING.RUNTIME`, sha256: '9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74' },
  },
];

async function toolchainText({ source }: ToolchainText): Promise<string> {
  const bytes = await downloadChecked(source.url, source.sha256, MAX_TOOLCHAIN_ARCHIVE_BYTES);
  if (source.members === undefined || source.compression === undefined) return bytes.toString('utf8');
  const members = listMembers(bytes, source.compression, source.members);
  return source.members
    .map((member) => {
      if (!members.get(member)) throw new Error(`${member} is not a regular file of ${source.url}`);
      const text = readMember(bytes, member, MAX_LICENSE_FILE_BYTES, source.compression as 'z' | 'J');
      if (text.trim() === '') throw new Error(`${member} is empty`);
      return `${member.slice(member.indexOf('/') + 1)}\n${'-'.repeat(40)}\n${text}`;
    })
    .join('\n');
}

export const packageLine = (licence: PackageLicence): string => `${licence.crate.name} ${licence.crate.version} (${licence.license})`;

function render(licences: readonly PackageLicence[], toolchain: ReadonlyArray<{ heading: string; text: string }>): string {
  const lock = readLock();
  const count = (origin: LockedPackage['origin']) => lock.filter((entry) => entry.origin === origin).length;
  return [
    `pandoc ${PANDOC_VERSION}: third-party notices`,
    '',
    'The pandoc program (GPL-2.0-or-later, John MacFarlane and contributors; its licence text and copyright notice are installed beside this',
    'file) is one statically linked executable that holds the code of the Haskell packages below and of some C libraries. It is built from',
    `commit ${PANDOC_COMMIT} with GHC 9.6.3 in an Alpine container`,
    '(`make debpkg`), by a cabal plan that the repository does not freeze, so the packages are the ones',
    `whose unit ids the release programs carry (${count('binary')} packages; ${count('ghc')} more libraries of GHC and ${count('plan')} packages that a listed package`,
    'requires unconditionally and that leave no unit id, which are named too because the list may then name a package whose code the linker',
    'dropped). Each text below is copied unmodified from the Hackage source archive of the packages named above it, checked against the SHA-256',
    'in scripts/pandoc-notices/packages.lock. The pandoc packages themselves (pandoc, pandoc-cli, pandoc-lua-engine, pandoc-server) are the',
    'program. Generated by scripts/generate-pandoc-notices.ts.',
    '',
    'The Lua interpreter (the lua package, Lua 5.4.4) and libyaml (the libyaml package) are bundled by Haskell packages, whose archives ship',
    'their texts. The bundled C code of crypton (argon2, blake2, decaf, ed25519, p256, curve25519 and others) keeps its licence in the headers of',
    'its source files, in the archive named above (BSD-3-Clause, MIT, CC0-1.0, Apache-2.0 or public domain), not in a separate file.',
    '',
    `Haskell packages (${licences.length}):`,
    ...licences.map(packageLine),
    '',
    'Other code linked into the programs, with the texts that follow the package texts: GHC and its runtime system, musl libc, GNU MP, zlib,',
    'libffi and the GCC runtime library. The versions of the Alpine packages are not recorded in the programs but for zlib (1.2.13) and GCC (12.2.1);',
    'the texts are those of the upstream release that matches, and do not differ between the Alpine releases that carry the programs\' versions.',
    'GNU MP is offered under the LGPL-3.0-or-later or the GPL-2.0-or-later, and the GCC runtime library carries the GCC Runtime Library Exception.',
    '',
    ...textBlocks(licences),
    ...toolchain.map(({ heading, text }) => block(heading, text)),
  ].join('\n');
}

async function verifyBinary(file: string): Promise<void> {
  const found = new Set(binaryPackages(fs.readFileSync(file)));
  const expected = new Set(readLock().filter((entry) => entry.origin === 'binary').map((entry) => `${entry.name} ${entry.version}`));
  const missing = [...expected].filter((entry) => !found.has(entry));
  const extra = [...found].filter((entry) => !expected.has(entry));
  console.log(`${file}: ${found.size} unit ids, the lock lists ${expected.size} binary packages`);
  if (missing.length > 0 || extra.length > 0) throw new Error(`the program and the lock differ: only in the lock: ${missing.join(', ') || 'none'}; only in the program: ${extra.join(', ') || 'none'}`);
}

async function main(): Promise<void> {
  const verify = process.argv.indexOf('--verify-binary');
  if (verify > 0) return verifyBinary(process.argv[verify + 1]);
  const lock = readLock();
  const names = new Set(lock.map((entry) => entry.name));
  const licences: PackageLicence[] = [];
  const unlocked: string[] = [];
  for (const entry of lock) {
    const archive = await downloadChecked(archiveUrl(entry), entry.sha256, MAX_PACKAGE_BYTES);
    licences.push(readPackageLicence(entry, archive));
    for (const dependency of libraryDependencies(readCabal(entry, archive), entry.name)) {
      if (!names.has(dependency)) unlocked.push(`${entry.name} requires ${dependency}`);
    }
  }
  if (unlocked.length > 0) throw new Error(`packages.lock lacks packages that its packages require: ${unlocked.join('; ')}`);
  const toolchain: Array<{ heading: string; text: string }> = [];
  for (const text of TOOLCHAIN_TEXTS) toolchain.push({ heading: text.heading, text: await toolchainText(text) });
  fs.writeFileSync(NOTICES_FILE, render(licences, toolchain), 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), NOTICES_FILE)}: ${licences.length} packages, SHA-256 ${sha256(fs.readFileSync(NOTICES_FILE))}`);
}

if (process.argv[1]?.endsWith('generate-pandoc-notices.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
