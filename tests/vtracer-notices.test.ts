import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOTICES_FILE,
  pinnedLinkedCrates,
  readPinned,
  sha256,
  UPSTREAM_DIGESTS,
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

/** The crates `strings` finds in the pinned aarch64 release program (their source paths stay in its panic messages). */
const CRATES_IN_THE_BINARY = [
  'anstream 1.0.0', 'anstyle 1.0.14', 'bit-vec 0.6.3', 'bytemuck 1.25.2', 'byteorder-lite 0.1.0', 'clap_builder 4.6.2', 'clap_lex 1.1.0',
  'fax 0.2.7', 'fdeflate 0.3.7', 'flate2 1.1.9', 'flo_curves 0.3.1', 'flo_curves 0.8.0', 'gif 0.14.2', 'image 0.25.10', 'image-webp 0.2.4',
  'miniz_oxide 0.8.9', 'png 0.18.1', 'qoi 0.4.1', 'strsim 0.11.1', 'tiff 0.11.3', 'visioncortex 0.9.3', 'weezl 0.1.12', 'zune-core 0.5.1',
  'zune-jpeg 0.5.15',
];

describe('the third-party notices of the tracer program', () => {
  it('come from the upstream files of the commit the install script pins', () => {
    expect(VTRACER_COMMIT).toBe(pin('VTRACER_COMMIT'));
    for (const [file, digest] of Object.entries(UPSTREAM_DIGESTS)) expect(sha256(readPinned(file)), file).toBe(digest);
  });

  it('name every crate of the Cargo.lock dependency graph of the program, and no development dependency', () => {
    const names = pinnedLinkedCrates().map((crate) => `${crate.name} ${crate.version}`);
    expect(listedCrates()).toEqual(names);
    expect(names).toEqual(expect.arrayContaining(CRATES_IN_THE_BINARY));
    expect(names.filter((name) => name.startsWith('resvg '))).toEqual([]);
  });

  it('carry the Apache-2.0 text for the crates that offer it without shipping it', () => {
    expect(noticesText).toMatch(/^Apache License 2\.0, the text offered without a copy by: vtracer 1\.0\.0-alpha\.4\b/m);
    expect(noticesText).toMatch(/Apache License\s+Version 2\.0, January 2004/);
  });

  it('are pinned by digest in the install script and installed beside the licence text of the program', () => {
    expect(pin('VTRACER_NOTICES_SHA256')).toBe(sha256(notices));
    expect(INSTALL).toMatch(/install -m 0644 "\$notices" "\$INSTALL_DIR\/share\/doc\/vtracer\/THIRD-PARTY-NOTICES"/);
    expect(INSTALL.indexOf('VTRACER_NOTICES_SHA256}  $notices"')).toBeLessThan(INSTALL.indexOf('install -m 0644 "$notices"'));
  });

  it('reach the worker image and its licence directory', () => {
    const stages = parseDockerfile(fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8'));
    const stage = stages.find((candidate) => candidate.name === 'vtracer');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toContain('scripts/vtracer-notices/THIRD-PARTY-NOTICES /tmp/vtracer-notices/THIRD-PARTY-NOTICES');
    const runner = stages[stages.length - 1];
    const runs = runner.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument);
    expect(runs).toContain('cp /usr/share/doc/vtracer/THIRD-PARTY-NOTICES /licenses/vtracer.THIRD-PARTY-NOTICES');
  });
});
