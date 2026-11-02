import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  electedLicence,
  LIBUNWIND_COMMIT,
  NOTICES_FILE,
  pinnedLinkedCrates,
  readCrateLicence,
  readPinned,
  RUST_SRC_SHA256,
  sha256,
  STD_CRATES,
  UPSTREAM_DIGESTS,
  UPSTREAM_DIR,
  VTRACER_COMMIT,
} from '../scripts/generate-vtracer-notices';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The vtracer program is one statically linked binary, so the licences of the crates built into it ship with it as one notices file.
 * The file must name every crate of the program's Cargo.lock dependency graph at the pinned commit, and the image must carry the
 * file the install script checked.
 */

const ROOT = path.resolve(__dirname, '..');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-vtracer.sh'), 'utf-8');
const notices = fs.readFileSync(NOTICES_FILE);
const noticesText = notices.toString('utf8');
const pin = (name: string): string => new RegExp(`^${name}="([^"]+)"$`, 'm').exec(INSTALL)?.[1] ?? '';

/** The crates the notices list: the lines after `Crates (n):` up to the first blank line, without the licence in brackets. */
function listedCrates(): string[] {
  const lines = noticesText.split('\n');
  const start = lines.findIndex((line) => /^Crates \(\d+\):$/.test(line)) + 1;
  const end = lines.indexOf('', start);
  return lines.slice(start, end).map((line) => line.replace(/ \(.*\)$/, ''));
}

/** The crates the header lists as vendored by the Rust standard library: the lines after `Rust standard library crates (n):`. */
function listedStdCrates(): string[] {
  const lines = noticesText.split('\n');
  const start = lines.findIndex((line) => /^Rust standard library crates \(\d+\):$/.test(line)) + 1;
  expect(start).toBeGreaterThan(0);
  return lines.slice(start, lines.indexOf('', start)).map((line) => line.replace(/ \(.*\)$/, ''));
}

/** The text blocks the notices write under a `Shipped by:` heading that names the crate. */
function textsShippedBy(crate: string): string[] {
  const rule = '='.repeat(80);
  const parts = noticesText.replaceAll('\r\n', '\n').split(`${rule}\n`);
  const texts: string[] = [];
  for (let at = 1; at < parts.length - 1; at += 2) {
    const heading = parts[at].trim();
    if (heading.startsWith('Shipped by: ') && heading.includes(`${crate} (`)) texts.push(parts[at + 1]);
  }
  return texts;
}

/** The crates `strings` finds in the pinned aarch64 release program (their source paths stay in its panic messages). */
const CRATES_IN_THE_BINARY = [
  'anstream 1.0.0', 'anstyle 1.0.14', 'bit-vec 0.6.3', 'bytemuck 1.25.2', 'byteorder-lite 0.1.0', 'clap_builder 4.6.2', 'clap_lex 1.1.0',
  'fax 0.2.7', 'fdeflate 0.3.7', 'flate2 1.1.9', 'flo_curves 0.3.1', 'flo_curves 0.8.0', 'gif 0.14.2', 'image 0.25.10', 'image-webp 0.2.4',
  'miniz_oxide 0.8.9', 'png 0.18.1', 'qoi 0.4.1', 'strsim 0.11.1', 'tiff 0.11.3', 'visioncortex 0.9.3', 'weezl 0.1.12', 'zune-core 0.5.1',
  'zune-jpeg 0.5.15',
];

/** Crates the program reaches only through another crate: `png` and `flate2` to `miniz_oxide` and `adler2`, `image` to `moxcms` and `pxfm`. */
const CRATES_REACHED_THROUGH_OTHERS = ['adler2 2.0.1', 'crc32fast 1.5.0', 'miniz_oxide 0.8.9', 'moxcms 0.8.1', 'pxfm 0.1.30', 'simd-adler32 0.3.10'];

describe('the third-party notices of the tracer program', () => {
  it('come from the upstream files of the commit the install script pins', () => {
    expect(VTRACER_COMMIT).toBe(pin('VTRACER_COMMIT'));
    for (const [file, digest] of Object.entries(UPSTREAM_DIGESTS)) expect(sha256(readPinned(file)), file).toBe(digest);
  });

  it('name every crate of the Cargo.lock dependency graph of the program, and no development dependency', () => {
    const names = pinnedLinkedCrates().map((crate) => `${crate.name} ${crate.version}`);
    expect(listedCrates()).toEqual(names);
    expect(names).toEqual(expect.arrayContaining(CRATES_IN_THE_BINARY));
    expect(names).toEqual(expect.arrayContaining(CRATES_REACHED_THROUGH_OTHERS));
    expect(names).toHaveLength(71);
    expect(names.filter((name) => name.startsWith('resvg '))).toEqual([]);
  });

  it('give every listed crate a licence text, but for the one crate whose archive ships none', () => {
    const shipping = new Set([...noticesText.matchAll(/^Shipped by: (.+)$/gm)].flatMap(([, labels]) => labels.split(/\), /).map((label) => label.replace(/ \(.*$/, ''))));
    expect(listedCrates().filter((crate) => !shipping.has(crate))).toEqual(['flo_curves 0.3.1']);
    expect(noticesText).toMatch(/^Crates whose archive ships no licence text, with the authors their manifest names:\nflo_curves 0\.3\.1 \(Apache-2\.0\): Andrew Hunter\n\n/m);
  });

  it('carry the notices of musl libc and of the Rust standard library, which the static musl build links in', () => {
    expect(noticesText).toMatch(/^musl libc 1\.2\.5 \(MIT\).*\n={80}\nmusl as a whole is licensed under the following standard MIT license:/m);
    expect(noticesText).toContain('Copyright © 2005-2020 Rich Felker, et al.');
    const rustCommit = /^Rust standard library .*commit ([0-9a-f]{40})/m.exec(noticesText)?.[1];
    expect(rustCommit).toBe('88d9e12ae178fab0fb5cc050a94da85685d449ea');
    expect(noticesText).toContain('The Rust Project is dual-licensed under Apache 2.0 and MIT');
    for (const file of ['COPYRIGHT', 'LICENSE-MIT', 'LICENSE-APACHE']) expect(noticesText).toMatch(new RegExp(`^Rust standard library .*: ${file} at commit ${rustCommit}$`, 'm'));
  });

  it('name the standard library crates the programs carry, the ones they name in their panic paths among them', () => {
    const names = listedStdCrates();
    expect(names).toEqual(STD_CRATES.map((crate) => `${crate.id.name} ${crate.id.version}`));
    expect(names).toEqual(
      expect.arrayContaining(['addr2line 0.25.1', 'gimli 0.32.3', 'hashbrown 0.17.1', 'miniz_oxide 0.8.9', 'rustc-demangle 0.1.27', 'compiler_builtins 0.1.160', 'object 0.37.3', 'memchr 2.7.6', 'adler2 2.0.1', 'cfg-if 1.0.4']),
    );
    expect(noticesText).toContain(`rust-src component 1.98.0 (SHA-256 ${RUST_SRC_SHA256})`);
  });

  it('carry the copyright line of every standard library crate the header names, from the text that crate ships', () => {
    for (const name of listedStdCrates()) {
      const texts = textsShippedBy(name);
      expect(texts.length, name).toBeGreaterThan(0);
      expect(texts.some((text) => /^\s*Copyright\b.*\S/im.test(text)), name).toBe(true);
    }
    expect(textsShippedBy('addr2line 0.25.1').join('\n')).toContain('Copyright (c) 2016-2018 The gimli Developers');
    expect(textsShippedBy('object 0.37.3').join('\n')).toContain('Copyright (c) 2015 The Gimli Developers');
    expect(textsShippedBy('hashbrown 0.17.1').join('\n')).toContain("Copyright (c) 2016 Amanieu d'Antras");
    expect(textsShippedBy('compiler_builtins 0.1.160').join('\n')).toContain('contributors listed in CREDITS.TXT');
  });

  it('carry the licence of LLVM libunwind, which the musl builds link statically, from the llvm-project commit the compiler commit pins', () => {
    expect(LIBUNWIND_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    const heading = new RegExp(`^LLVM libunwind .*libunwind/LICENSE\\.TXT at rust-lang/llvm-project commit ${LIBUNWIND_COMMIT}$`, 'm');
    expect(noticesText).toMatch(heading);
    const rule = '='.repeat(80);
    const at = noticesText.search(heading);
    const text = noticesText.slice(at).split(`${rule}\n`)[1].replaceAll('\r\n', '\n');
    expect(text).toContain('Apache License');
    expect(text).toContain('LLVM Exceptions to the Apache 2.0 License');
    expect(text).toContain('Copyright (c) 2009-2019 by the contributors listed in CREDITS.TXT');
  });

  it('state the licence elected for each crate offered under several, and that the MIT text and its copyright line are included', () => {
    const offered = noticesText.split('\n').filter((line) => /^[A-Za-z0-9_.-]+ \d.* \((.* OR .*|\S+\/\S+)\)$/.test(line) && !line.includes(' AND '));
    expect(offered.length).toBeGreaterThan(60);
    for (const line of offered) expect(line, line).toMatch(/; elected (MIT|Apache-2\.0)\)$/);
    expect(noticesText).toMatch(/where a crate is offered under several licences, the one elected is MIT/i);
    expect(listedStdCrates().length).toBe(STD_CRATES.length);
  });

  it('carry the Apache-2.0 text for the crates that offer it without shipping it', () => {
    expect(noticesText).toMatch(/^Apache License 2\.0, the text offered without a copy by: vtracer 1\.0\.0-alpha\.4\b/m);
    expect(noticesText).toMatch(/Apache License\s+Version 2\.0, January 2004/);
  });

  it('are pinned by digest in the install script, checked before any download, and installed beside the licence text of the program', () => {
    expect(pin('VTRACER_NOTICES_SHA256')).toBe(sha256(notices));
    expect(INSTALL).toMatch(/install -m 0644 "\$notices" "\$INSTALL_DIR\/share\/doc\/vtracer\/THIRD-PARTY-NOTICES"/);
    const check = INSTALL.indexOf('VTRACER_NOTICES_SHA256}  $notices"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(INSTALL.indexOf('\nfetch '));
  });

  it('keep their CRLF lines, and the upstream files their digests cover, in any checkout, so the pinned digests hold', () => {
    const files = [NOTICES_FILE, ...Object.keys(UPSTREAM_DIGESTS).map((file) => path.join(UPSTREAM_DIR, `${file}.pinned`))].map((file) => path.relative(ROOT, file));
    const attributes = execFileSync('git', ['check-attr', 'text', '--', ...files], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
    expect(attributes).toHaveLength(files.length);
    for (const attribute of attributes) expect(attribute.endsWith(': text: unset'), attribute).toBe(true);
    expect(noticesText).toContain('\r\n');
  });

  it('reach the worker image and its licence directory', () => {
    const stages = parseDockerfile(fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8'));
    const stage = stages.find((candidate) => candidate.name === 'vtracer');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toEqual(['scripts/install-vtracer.sh /tmp/install-vtracer.sh', 'scripts/vtracer-notices/THIRD-PARTY-NOTICES /tmp/vtracer-notices/THIRD-PARTY-NOTICES']);
    const runner = stages[stages.length - 1];
    const runs = runner.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument);
    expect(runs.filter((run) => run.includes('THIRD-PARTY-NOTICES'))).toEqual(['cp /usr/share/doc/vtracer/THIRD-PARTY-NOTICES /licenses/vtracer.THIRD-PARTY-NOTICES']);
  });
});

/** A crates.io archive of the files given, as `cargo package` writes it: every member under `<name>-<version>/`. */
function crateArchive(files: Record<string, string | { symlinkTo: string }>, name = 'demo', version = '1.0.0'): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-'));
  try {
    const root = path.join(dir, `${name}-${version}`);
    for (const [file, content] of Object.entries({ 'Cargo.toml': `[package]\nname = "${name}"\nversion = "${version}"\nlicense = "MIT"\n`, ...files })) {
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

const read = (archive: Buffer, name = 'demo', version = '1.0.0') => readCrateLicence({ name, version }, archive);

describe('electing one licence of an expression', () => {
  const mitText = { text: 'MIT License\n\nCopyright (c) 2015 Someone\n\nPermission is hereby granted, free of charge, to any person\n' };

  it('elects MIT when it is offered and the crate ships an MIT text with a copyright line', () => {
    for (const expression of ['MIT OR Apache-2.0', '0BSD OR MIT OR Apache-2.0', 'Unlicense OR MIT', 'MIT/Apache-2.0', 'Zlib OR Apache-2.0 OR MIT']) {
      expect(electedLicence(expression, [mitText]), expression).toBe('MIT');
    }
  });

  it('elects Apache-2.0 when MIT is not offered, or its text has no copyright line, and names none for one licence', () => {
    expect(electedLicence('BSD-3-Clause OR Apache-2.0', [mitText])).toBe('Apache-2.0');
    expect(electedLicence('MIT OR Apache-2.0', [{ text: 'Permission is hereby granted, free of charge\n' }])).toBe('Apache-2.0');
    expect(electedLicence('MIT', [mitText])).toBeUndefined();
    expect(electedLicence('MIT AND Apache-2.0 WITH LLVM-exception AND (MIT OR Apache-2.0)', [mitText])).toBeUndefined();
  });

  it('stops at an expression that offers neither', () => {
    expect(() => electedLicence('BSD-3-Clause OR Zlib', [mitText])).toThrow('offers neither');
  });
});

describe('reading the licence texts of a crate archive', () => {
  it('reads an UNLICENSE next to the other licence files', () => {
    const licence = read(crateArchive({ UNLICENSE: 'This is free and unencumbered software released into the public domain.\n', 'LICENSE-MIT': 'MIT text\n' }));
    expect(licence.texts.map(({ file }) => file)).toEqual(['LICENSE-MIT', 'UNLICENSE']);
  });

  it('reads the root licence files and the texts of a REUSE LICENSES directory', () => {
    const licence = read(crateArchive({ 'LICENSE-MIT': 'MIT text\n', 'LICENSES/Apache-2.0.txt': 'Apache text\n', 'src/LICENSE.rs': 'not a licence\n' }));
    expect(licence.texts).toEqual([
      { file: 'LICENSE-MIT', text: 'MIT text\n' },
      { file: 'LICENSES/Apache-2.0.txt', text: 'Apache text\n' },
    ]);
  });

  it('stops at an empty licence file', () => {
    expect(() => read(crateArchive({ LICENSE: '' }))).toThrow('demo-1.0.0/LICENSE is empty');
  });

  it('stops at a licence file that is not a regular file', () => {
    expect(() => read(crateArchive({ 'LICENSE-MIT': 'MIT text\n', LICENSE: { symlinkTo: 'LICENSE-MIT' } }))).toThrow('demo-1.0.0/LICENSE is not a regular file');
  });

  it('stops at a licence file whose name tar would read as a pattern', () => {
    expect(() => read(crateArchive({ 'LICENSE-[x]': 'text\n' }))).toThrow('demo-1.0.0/LICENSE-[x] is not a name tar reads literally');
  });

  it('stops at a crate that ships no licence text, but for the crate known to ship none', () => {
    expect(() => read(crateArchive({ 'README.md': 'demo\n' }))).toThrow('demo 1.0.0 ships no licence text');
    expect(read(crateArchive({ 'README.md': 'curves\n' }, 'flo_curves', '0.3.1'), 'flo_curves', '0.3.1').texts).toEqual([]);
  });
});
