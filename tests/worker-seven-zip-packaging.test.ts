import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SEVEN_ZIP_BINARY_CANDIDATES, findSevenZipBinary } from '../src/lib/conversions/archive';
import { convertWithNative7z } from '../src/worker/engines';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildStoredRar4, type StoredRarEntry } from './helpers/rar4-stored';

/**
 * The worker image installs the pinned upstream 7-Zip as `7zz`. These tests cover what the image
 * relies on: the Dockerfile pins and verifies the download, the engines find a 7-Zip installed
 * under either name, and the binary the worker resolves still unpacks RAR input.
 */

const DOCKERFILE = fs.readFileSync(path.resolve(__dirname, '../Dockerfile.worker'), 'utf-8');

function dockerArg(name: string): string {
  const match = new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(DOCKERFILE);
  if (!match) throw new Error(`Dockerfile.worker has no ARG ${name}`);
  return match[1];
}

function installedAt(...installed: string[]): (candidate: string) => boolean {
  const present = new Set(installed);
  return (candidate) => present.has(candidate);
}

describe('7-Zip binary resolution', () => {
  it('finds an upstream 7zz in every install directory', () => {
    expect(findSevenZipBinary(installedAt('/usr/bin/7zz'))).toBe('/usr/bin/7zz');
    expect(findSevenZipBinary(installedAt('/usr/local/bin/7zz'))).toBe('/usr/local/bin/7zz');
    expect(findSevenZipBinary(installedAt('/opt/homebrew/bin/7zz'))).toBe('/opt/homebrew/bin/7zz');
  });

  it('still finds the p7zip names', () => {
    expect(findSevenZipBinary(installedAt('/usr/bin/7z'))).toBe('/usr/bin/7z');
    expect(findSevenZipBinary(installedAt('/usr/local/bin/7za'))).toBe('/usr/local/bin/7za');
  });

  it('prefers 7zz over a p7zip 7z installed on the same host', () => {
    expect(findSevenZipBinary(installedAt('/usr/bin/7z', '/usr/local/bin/7zz'))).toBe('/usr/local/bin/7zz');
    expect(findSevenZipBinary(installedAt('/usr/bin/7z', '/usr/bin/7za', '/usr/bin/7zr'))).toBe('/usr/bin/7z');
  });

  it('uses the reduced 7zr only when nothing else is installed, and reports a missing 7-Zip as null', () => {
    expect(findSevenZipBinary(installedAt('/usr/bin/7zr'))).toBe('/usr/bin/7zr');
    expect(findSevenZipBinary(installedAt('/usr/bin/7za', '/usr/bin/7zr'))).toBe('/usr/bin/7za');
    expect(findSevenZipBinary(installedAt())).toBeNull();
  });

  it('lists 7zz first in the shared candidate table the worker also reads', () => {
    expect(SEVEN_ZIP_BINARY_CANDIDATES.slice(0, 3)).toEqual([
      '/usr/bin/7zz',
      '/usr/local/bin/7zz',
      '/opt/homebrew/bin/7zz',
    ]);
    expect(SEVEN_ZIP_BINARY_CANDIDATES).toContain('/usr/bin/7z');
  });
});

describe('Dockerfile.worker 7-Zip install', () => {
  it('no longer installs the legacy p7zip packages from apt', () => {
    expect(DOCKERFILE).not.toMatch(/^\s+p7zip[\w-]*\s*\\?$/m);
  });

  it('pins one SHA-256 digest per architecture', () => {
    const x64 = dockerArg('SEVEN_ZIP_SHA256_X64');
    const arm64 = dockerArg('SEVEN_ZIP_SHA256_ARM64');
    expect(x64).toMatch(/^[0-9a-f]{64}$/);
    expect(arm64).toMatch(/^[0-9a-f]{64}$/);
    expect(x64).not.toBe(arm64);
  });

  it('names the release archive from the pinned version, 7z<release>-linux-<arch>', () => {
    const version = dockerArg('SEVEN_ZIP_VERSION');
    const release = dockerArg('SEVEN_ZIP_RELEASE');
    expect(release).toBe(version.replace('.', ''));
    expect(DOCKERFILE).toContain('/releases/download/${SEVEN_ZIP_VERSION}/7z${SEVEN_ZIP_RELEASE}-linux-${SEVEN_ZIP_ARCH}.tar.xz');
  });

  it('checks the digest before unpacking and fails the build on an architecture without a pin', () => {
    const check = DOCKERFILE.indexOf('sha256sum --check --strict');
    const unpack = DOCKERFILE.indexOf('tar -xJf /tmp/7zip.tar.xz');
    expect(check).toBeGreaterThan(0);
    expect(unpack).toBeGreaterThan(check);
    expect(DOCKERFILE).toMatch(/\*\) echo "No pinned 7-Zip build for .*exit 1 ;;/);
  });

  it('fails the build when the RAR decoder is missing, and installs the static build as 7zz with a 7z alias', () => {
    expect(DOCKERFILE).toMatch(/\/seven-zip\/7zzs i > \/tmp\/7zip-formats\.txt \\\n\s+&& grep -q ' Rar5 ' \/tmp\/7zip-formats\.txt/);
    expect(DOCKERFILE).toMatch(/^COPY --from=sevenzip \/seven-zip\/7zzs \/usr\/local\/bin\/7zz$/m);
    expect(DOCKERFILE).toMatch(/^RUN ln -s 7zz \/usr\/local\/bin\/7z$/m);
  });
});

describe('the 7-Zip the worker resolves reads RAR input', () => {
  const ENTRIES: readonly StoredRarEntry[] = [
    { name: 'notes.txt', data: Buffer.from('stored rar entry\n', 'utf-8') },
    { name: 'data/values.csv', data: Buffer.from('id,value\n1,alpha\n2,beta\n', 'utf-8') },
  ];

  oracleTest('worker convertWithNative7z unpacks a RAR 4.x archive to zip, bytes intact', ['7z'], async () => {
    const result = await convertWithNative7z(buildStoredRar4(ENTRIES), 'rar', 'zip', { throwOnUnavailable: true }, 'input.rar');
    expect(result?.engineUsed).toBe('native-7z');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-zip-rar-'));
    try {
      const zipPath = path.join(dir, 'out.zip');
      fs.writeFileSync(zipPath, result!.buffer);
      // The reference CLI on PATH unpacks the result, not the engine under test.
      execFileSync(getOracleToolPath('7z')!, ['x', '-y', `-o${path.join(dir, 'out')}`, zipPath], { stdio: 'pipe' });
      for (const entry of ENTRIES) {
        const unpacked = fs.readFileSync(path.join(dir, 'out', entry.name));
        expect(unpacked.equals(entry.data), `${entry.name} differs from the RAR entry`).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
