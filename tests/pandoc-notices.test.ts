import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archiveUrl,
  binaryPackages,
  libraryDependencies,
  LOCK_FILE,
  NOTICES_FILE,
  PANDOC_COMMIT,
  parseLock,
  readLock,
  readPackageLicence,
  TOOLCHAIN_TEXTS,
} from '../scripts/generate-pandoc-notices';
import { sha256 } from '../scripts/generate-vtracer-notices';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The pandoc program is one statically linked executable, so the licences of the Haskell packages and C libraries built into it ship with it as
 * one notices file. The file must name every package of packages.lock (the unit ids of the release programs and what they require), carry a
 * text for each, and the image must carry the file the install script checked.
 */

const ROOT = path.resolve(__dirname, '..');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-pandoc.sh'), 'utf-8');
const notices = fs.readFileSync(NOTICES_FILE);
const noticesText = notices.toString('utf8').replaceAll('\r\n', '\n');
const lock = readLock();
const pin = (name: string): string => new RegExp(`^${name}="([^"]+)"$`, 'm').exec(INSTALL)?.[1] ?? '';
const RULE = '='.repeat(80);

/** The lines after `Haskell packages (n):` up to the first blank line, without the licence in brackets. */
function listedPackages(): string[] {
  const lines = noticesText.split('\n');
  const start = lines.findIndex((line) => /^Haskell packages \(\d+\):$/.test(line)) + 1;
  expect(start).toBeGreaterThan(0);
  return lines.slice(start, lines.indexOf('', start)).map((line) => line.replace(/ \(.*\)$/, ''));
}

/** The heading and the text of every block of the notices. */
function blocks(): Array<{ heading: string; text: string }> {
  const parts = noticesText.split(`${RULE}\n`);
  const found: Array<{ heading: string; text: string }> = [];
  for (let at = 1; at < parts.length - 1; at += 2) found.push({ heading: parts[at].trim(), text: parts[at + 1] });
  return found;
}

describe('the package list of the pandoc program', () => {
  it('names each package once, in order, with a digest and an origin, and not the pandoc packages themselves', () => {
    expect(lock.length).toBe(219);
    expect(lock.filter((entry) => entry.origin === 'binary')).toHaveLength(187);
    expect(lock.filter((entry) => entry.origin === 'plan')).toHaveLength(28);
    expect(lock.filter((entry) => entry.origin === 'ghc').map((entry) => entry.name)).toEqual(['base', 'ghc-bignum', 'ghc-prim', 'template-haskell']);
    expect(lock.filter((entry) => /^pandoc(-|$)/.test(entry.name) && entry.name !== 'pandoc-types' && entry.name !== 'pandoc-lua-marshal')).toEqual([]);
  });

  it('contains the packages the release programs are known to link', () => {
    const names = new Set(lock.map((entry) => `${entry.name} ${entry.version}`));
    for (const known of ['aeson 2.1.2.1', 'citeproc 0.8.1', 'commonmark 0.2.4.1', 'lua 2.3.1', 'lpeg 1.1.0', 'texmath 0.12.8.6', 'skylighting 0.14.1', 'zlib 0.6.3.0', 'integer-gmp 1.1', 'text 2.0.2', 'tls 1.9.0', 'warp 3.3.31', 'xml 1.3.14']) {
      expect(names.has(known), known).toBe(true);
    }
    expect(lock.find((entry) => entry.name === 'text-conversions')?.origin).toBe('plan');
  });

  it('is read by the generator as lines of a name, a version, a SHA-256 and an origin, and refuses anything else', () => {
    const digest = 'a'.repeat(64);
    expect(parseLock(`# note\n\nOneTuple 0.4.1.1 ${digest} plan\naeson 2.1.2.1 ${digest} binary\n`)).toEqual([
      { name: 'OneTuple', version: '0.4.1.1', sha256: digest, origin: 'plan' },
      { name: 'aeson', version: '2.1.2.1', sha256: digest, origin: 'binary' },
    ]);
    expect(() => parseLock(`aeson 2.1.2.1 ${digest} other\n`)).toThrow('is not "<package> <version> <sha256> <origin>"');
    expect(() => parseLock(`aeson 2.1.2.1 ${'a'.repeat(63)} binary\n`)).toThrow('is not "<package>');
    expect(() => parseLock(`aeson 2.1.2.1 ${digest} binary\naeson 2.1.2.2 ${digest} binary\n`)).toThrow('names a package twice');
    expect(() => parseLock(`b 1 ${digest} binary\na 1 ${digest} binary\n`)).toThrow('is not sorted');
  });

  it('is fetched from Hackage by package and version', () => {
    expect(archiveUrl({ name: 'aeson', version: '2.1.2.1' })).toBe('https://hackage.haskell.org/package/aeson-2.1.2.1/aeson-2.1.2.1.tar.gz');
    expect(fs.readFileSync(LOCK_FILE, 'utf8')).toMatch(/^# The Haskell packages statically linked into the pinned pandoc 3\.1\.11 release programs/);
  });
});

describe('reading the unit ids of a release program', () => {
  const hash = 'b'.repeat(64);

  it('finds the packages with a hashed unit id and the libraries of GHC with a plain one, once each', () => {
    const program = Buffer.from(`\0aeson-2.1.2.1-${hash}:Data.Aeson\0hslua-module-text-1.1.0.1-${hash}\0aeson-2.1.2.1-${hash}\0text-2.0.2\0integer-gmp-1.1\0not-a-package-1.0\0copyleft-next-0.3.0\0`, 'latin1');
    expect(binaryPackages(program)).toEqual(['aeson 2.1.2.1', 'hslua-module-text 1.1.0.1', 'integer-gmp 1.1', 'text 2.0.2']);
  });

  it('does not take a longer name for the library of GHC it ends with, or a prefix of a hash for the whole', () => {
    expect(binaryPackages(Buffer.from(`\0text-iso8601-0.1-${hash}\0text-short-0.1.5\0xtext-2.0.2\0aeson-2.1.2.1-${hash}ab\0`, 'latin1'))).toEqual(['text-iso8601 0.1']);
  });
});

describe('the requirements of a package library', () => {
  const cabal = `cabal-version: 2.2
name: demo
common shared
  build-depends: base >= 4 && < 5, text
  -- containers is only mentioned
library
  import: shared
  build-depends:
      bytestring >= 0.10
    , demo:demo-internal
    , mtl
  if impl(ghc < 8)
    build-depends: semigroups
  else
    if os(windows)
      build-depends: Win32
  build-depends: scientific
library demo-internal
  build-depends: unordered-containers
test-suite spec
  build-depends: tasty
`;

  it('are the ones outside any condition, with the common stanzas it imports and without sublibraries and test suites', () => {
    expect([...libraryDependencies(cabal, 'demo')].sort()).toEqual(['base', 'bytestring', 'mtl', 'scientific', 'text']);
  });

  it('are the ones of the library that carries the name of the package when it is named', () => {
    expect([...libraryDependencies('library demo\n  build-depends: base, split\n', 'demo')].sort()).toEqual(['base', 'split']);
  });
});

/** A Hackage source archive of the files given, every member under `<name>-<version>/`. */
function sourceArchive(files: Record<string, string | { symlinkTo: string }>, name = 'demo', version = '1.0.0'): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackage-'));
  try {
    const root = path.join(dir, `${name}-${version}`);
    for (const [file, content] of Object.entries<string | { symlinkTo: string }>({ [`${name}.cabal`]: `name: ${name}\nversion: ${version}\nlicense: MIT\nlicense-file: LICENSE\n`, ...files })) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (typeof content === 'string') fs.writeFileSync(target, content);
      else fs.symlinkSync(content.symlinkTo, target);
    }
    return execFileSync('tar', ['-cz', '-f', '-', '-C', dir, `${name}-${version}`], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (archive: Buffer, name = 'demo', version = '1.0.0') => readPackageLicence({ name, version }, archive);

describe('reading the licence texts of a Hackage source archive', () => {
  it('reads the licence files of the root, the file the cabal file names and the licence field', () => {
    const licence = read(sourceArchive({ LICENSE: 'MIT text\n', 'COPYING.md': 'copying\n', 'docs/LICENSE.rst': 'not a licence of the package\n' }));
    expect(licence.license).toBe('MIT');
    expect(licence.texts).toEqual([
      { file: 'COPYING.md', text: 'copying\n' },
      { file: 'LICENSE', text: 'MIT text\n' },
    ]);
  });

  it('reads the texts that a package bundles beside the code of a C library', () => {
    const licence = read(sourceArchive({ LICENSE: 'Haskell text\n', 'libyaml_src/LICENSE': 'libyaml text\n' }, 'libyaml', '0.1.2'), 'libyaml', '0.1.2');
    expect(licence.texts.map(({ file }) => file)).toEqual(['LICENSE', 'libyaml_src/LICENSE']);
  });

  it('stops at an empty licence file', () => {
    expect(() => read(sourceArchive({ LICENSE: '' }))).toThrow('demo-1.0.0/LICENSE is empty');
  });

  it('stops at a licence file that is not a regular file', () => {
    expect(() => read(sourceArchive({ 'COPYING': 'text\n', LICENSE: { symlinkTo: 'COPYING' } }))).toThrow('demo-1.0.0/LICENSE is not a regular file');
  });

  it('stops at a package that ships no licence text, and at a cabal file without a licence field', () => {
    expect(() => read(sourceArchive({ 'README.md': 'demo\n' }))).toThrow('demo 1.0.0 ships no licence text');
    expect(() => read(sourceArchive({ LICENSE: 'text\n', 'demo.cabal': 'name: demo\n' }))).toThrow('has no license field');
  });
});

describe('the third-party notices of the pandoc program', () => {
  it('name every package of the list, in its order, and carry the program commit the list belongs to', () => {
    expect(listedPackages()).toEqual(lock.map((entry) => `${entry.name} ${entry.version}`));
    expect(noticesText).toContain(`commit ${PANDOC_COMMIT} with GHC 9.6.3`);
    expect(PANDOC_COMMIT).toBe(pin('PANDOC_COMMIT'));
  });

  it('give every package of the list a licence text with a copyright line or a licence name, and no empty text', () => {
    const shipping = new Set(blocks().flatMap(({ heading }) => (heading.startsWith('Shipped by: ') ? heading.slice('Shipped by: '.length).split(/\), /).map((label) => label.replace(/ \(.*$/, '')) : [])));
    expect(lock.map((entry) => `${entry.name} ${entry.version}`).filter((name) => !shipping.has(name))).toEqual([]);
    for (const { heading, text } of blocks()) {
      expect(text.trim().length, heading).toBeGreaterThan(40);
      expect(text, heading).toMatch(/Copyright|licen[cs]e|LICENSE|GNU|Permission/i);
    }
  });

  it('carry the copyright holders of packages of different origins', () => {
    const textOf = (name: string): string =>
      blocks()
        .filter(({ heading }) => heading.startsWith('Shipped by: ') && heading.includes(`${name} (`))
        .map(({ text }) => text)
        .join('\n');
    expect(textOf('aeson 2.1.2.1')).toMatch(/Copyright/);
    expect(textOf('lua 2.3.1')).toContain('Copyright © 1994-2022 Lua.org, PUC-Rio.');
    expect(textOf('libyaml 0.1.2')).toContain('Copyright (c) 2006-2016 Kirill Simonov');
    expect(textOf('digest 0.0.2.0')).toContain('Copyright 2017, The CRC32C Authors.');
    expect(textOf('texmath 0.12.8.6')).toContain('GNU GENERAL PUBLIC LICENSE');
    expect(textOf('unicode-data 0.4.0.1')).toContain('Apache License');
  });

  it('carry the licences of GHC and its runtime, musl libc, GNU MP, zlib, libffi and the GCC runtime library, each from a pinned source', () => {
    expect(TOOLCHAIN_TEXTS.map(({ source }) => source.sha256)).toHaveLength(7);
    for (const { source } of TOOLCHAIN_TEXTS) expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    const headings = blocks().map(({ heading }) => heading);
    for (const start of ['GHC 9.6.3 ', 'musl libc ', 'GNU MP ', 'zlib 1.2.13 ', 'libffi ', 'GCC runtime library ', 'GCC runtime library exception ']) {
      expect(headings.some((heading) => heading.startsWith(start)), start).toBe(true);
    }
    expect(noticesText).toContain('The Glasgow Haskell Compiler License');
    expect(noticesText).toContain('musl as a whole is licensed under the following standard MIT license:');
    expect(noticesText).toContain('The GNU MP Library is free software');
    expect(noticesText).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(noticesText).toContain('(C) 1995-2022 Jean-loup Gailly and Mark Adler');
    expect(noticesText).toContain('libffi - Copyright (c)');
    expect(noticesText).toContain('GCC RUNTIME LIBRARY EXCEPTION');
  });

  it('are pinned by digest in the install script, checked before any download, and installed beside the licence text of the program', () => {
    expect(pin('PANDOC_NOTICES_SHA256')).toBe(sha256(notices));
    expect(INSTALL).toMatch(/install -m 0644 "\$notices" "\$INSTALL_DIR\/share\/doc\/pandoc\/THIRD-PARTY-NOTICES"/);
    const check = INSTALL.indexOf('PANDOC_NOTICES_SHA256}  $notices"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(INSTALL.indexOf('\ncached_fetch '));
  });

  it('keep their line endings in any checkout, so the pinned digests hold', () => {
    const files = [NOTICES_FILE, LOCK_FILE].map((file) => path.relative(ROOT, file));
    const attributes = execFileSync('git', ['check-attr', 'text', '--', ...files], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
    expect(attributes).toHaveLength(files.length);
    for (const attribute of attributes) expect(attribute.endsWith(': text: unset'), attribute).toBe(true);
    expect(notices.toString('utf8')).toContain('\r\n');
  });

  it('reach the worker image and its licence directory', () => {
    const stages = parseDockerfile(fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8'));
    const copies = stages.find((candidate) => candidate.name === 'pandoc')?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toEqual(['scripts/install-pandoc.sh /tmp/install-pandoc.sh', 'scripts/pandoc-notices/THIRD-PARTY-NOTICES /tmp/pandoc-notices/THIRD-PARTY-NOTICES']);
    const runs = stages[stages.length - 1].instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument);
    expect(runs.filter((run) => run.includes('THIRD-PARTY-NOTICES') && run.includes('pandoc'))).toEqual(['cp /usr/share/doc/pandoc/THIRD-PARTY-NOTICES /licenses/pandoc.THIRD-PARTY-NOTICES']);
  });
});
