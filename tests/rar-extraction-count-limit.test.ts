import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractRarArchive } from '../src/lib/conversions/archive';
import { buildStoredRar4 } from './helpers/rar4-stored';

/**
 * The file count of the caller is held for every file unrar leaves on disk, not only for those the request selects: an extraction
 * that asks for one entry of a large archive reads, and counts, the directory the way it reads a full one. unrar is replaced by a
 * script that lists two names (so the listing passes) and writes `FILES_ON_DISK` files, which is what the walk of the directory has to
 * hold on its own: the names unrar lists are not the files it writes (parent directories, entries a listing does not show).
 */

const FILES_ON_DISK = 1_500;
const CALLER_LIMITS = { MAX_FILES: 1_000, MAX_UNCOMPRESSED_SIZE: 50 * 1024 * 1024, MAX_RATIO: 100_000 };

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rar-count-limit-'));
  const script = path.join(workDir, 'unrar');
  fs.writeFileSync(
    script,
    `#!/bin/sh
if [ -f "${workDir}/symlink-mode" ]; then
  case "$1" in
    lb) printf 'wanted.txt\\nlink.txt\\n' ;;
    x) echo wanted > wanted.txt; ln -s /etc/passwd link.txt ;;
  esac
  exit 0
fi
case "$1" in
  lb) printf 'wanted.txt\\nother.txt\\n' ;;
  x) i=0; while [ $i -lt ${FILES_ON_DISK} ]; do echo "file $i" > "f$i.txt"; i=$((i+1)); done; echo wanted > wanted.txt ;;
esac
`,
    { mode: 0o755 }
  );
  process.env.UNRAR_PATH = script;
});
afterAll(() => {
  delete process.env.UNRAR_PATH;
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('the file count of an RAR extraction', () => {
  const rar = buildStoredRar4([{ name: 'wanted.txt', data: Buffer.from('wanted') }]);

  it('is held for the files on disk when the request selects one entry', () => {
    expect(() => extractRarArchive(rar, { limits: CALLER_LIMITS, entries: ['wanted.txt'] })).toThrow(/file count exceeds limit of 1000/);
  });

  it('is held for the files on disk when the request selects every entry', () => {
    expect(() => extractRarArchive(rar, { limits: CALLER_LIMITS })).toThrow(/file count exceeds limit of 1000/);
  });

  it('lets an extraction within the count return the selected entry', () => {
    const files = extractRarArchive(rar, { limits: { ...CALLER_LIMITS, MAX_FILES: 2_000 }, entries: ['wanted.txt'] });
    expect(files.map((file) => file.filename)).toEqual(['wanted.txt']);
  });

  it('refuses an archive whose extraction writes a symbolic link', () => {
    const marker = path.join(workDir, 'symlink-mode');
    fs.writeFileSync(marker, '1');
    try {
      expect(() => extractRarArchive(rar, { limits: CALLER_LIMITS })).toThrow(
        'Archive contains symbolic links, which are not permitted for security reasons'
      );
    } finally {
      fs.rmSync(marker, { force: true });
    }
  });
});

