import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactPaths } from '../src/lib/security/redact';
import { serverPathRoots } from '../src/lib/security/server-paths';
import { SCALING_TEST_TIMEOUT_MS, expectNoHangOnInput } from './helpers/timing';

/**
 * A failure reason is stored and shown to support, so only the paths of the server's own directories are masked: the
 * temporary directory, the storage directory, the working directory and the install directories of the engines. Every
 * other slash (a PDF name, an end tag, a JSON pointer, a MIME type, a ratio, a URL) is part of what went wrong.
 * Samples are those two reviewers ran against the earlier pattern.
 */

const ROOTS = ['/tmp', '/app', '/usr', '/usr/local', '/bin', '/opt/easyconvert-missing', '/var/lib/easyconvert/storage', '/home/ubuntu/ec'];
const MIB = 1024 * 1024;

const MASKED: Array<[string, string]> = [
  ['spawn /usr/bin/magick ENOENT', 'spawn *** ENOENT'],
  ['Sandboxed execution error: spawn /opt/easyconvert-missing/bin/magick ENOENT', 'Sandboxed execution error: spawn *** ENOENT'],
  ["ENOENT: no such file or directory, open '/tmp/ec-abc123/input.heic'", "ENOENT: no such file or directory, open '***'"],
  ['Error: Command failed: /usr/bin/ffmpeg -i /tmp/job-1/in.mp4 -y /tmp/job-1/out.webm', 'Error: Command failed: *** -i *** -y ***'],
  ['at Object.<anonymous> (/app/dist/worker.js:120:15)', 'at Object.<anonymous> (***:120:15)'],
  ['Cannot find module /app/dist/x.js imported from file:///app/dist/y.js', 'Cannot find module *** imported from file://***'],
  ['cwd:/var/lib/easyconvert/storage/jobs/7', 'cwd:***'],
  ['PATH=/usr/local/bin:/usr/bin:/bin', 'PATH=***:***:***'],
  ['open "/home/ubuntu/ec/tmp/a b/c.pdf"', 'open "***"'],
  ['/tmp/ec-xyz/한글.pdf: parse error', '***: parse error'],
  ['/tmp/ec-xyz/file name with spaces.pdf: parse error', '***: parse error'],
  ['/tmp/ec-xyz/report (1).pdf: parse error', '***: parse error'],
  ['path=/tmp/x/y;/etc/passwd', 'path=***;/etc/passwd'],
  ['Error loading shared library /usr/lib/x86_64-linux-gnu/libfoo.so.1: No such file', 'Error loading shared library ***: No such file'],
  ['dir /tmp: missing', 'dir ***: missing'],
  ['magick: unable to open image `/tmp/w/in.psd\' @ error/blob.c/OpenBlob/3596.', "magick: unable to open image `***' @ error/blob.c/OpenBlob/3596."],
];

const KEPT: string[] = [
  'Invalid /Root entry in PDF trailer; missing /Pages /Kids /Type /Catalog',
  'Filter /FlateDecode failed; use /DCTDecode',
  'Unexpected end tag </div> at line 3; XML parse error: </note>',
  'JSON pointer /items/0/name is not a string',
  'text starting with slash: /dev/null; rate 3 /s',
  '/proc/self/fd/3',
  'Unsupported MIME type image/png for audio/mpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'video/mp4; codecs="avc1.64001e"',
  'ratio 1/2 and 16/9, N/A, I/O error, and/or TCP/IP',
  'dates 2026/11/02 and 11/2',
  'Pages 1/3 done',
  '/2 pages',
  'PDF/A-1b validation failed (PDF/A)',
  'AAC/H.264 + MP3/ID3',
  '(see /doc/readme) for details',
  'a user file named "/etc/passwd" was uploaded',
  'EACCES: permission denied, mkdir /srv/data/jobs/123',
  'https://api.easyconvert.io/problems/quota-exceeded and http://host/tmp/a/b',
  's3://bucket/tmp/key.pdf',
  'redis://redis-prod.internal:6379/0 refused',
  'in ~/work/a.pdf, ./out/a.png and ../x/y.png',
  'C:\\Users\\x\\a.pdf',
  '/tmpfiles/a and /application/x and /usrx',
];

describe('redactPaths masks the paths under the server roots only', () => {
  it.each(MASKED)('masks %j', (text, masked) => {
    expect(redactPaths(text, ROOTS)).toBe(masked);
  });

  it.each(KEPT)('keeps %j', (text) => {
    expect(redactPaths(text, ROOTS)).toBe(text);
  });

  it('masks nothing without roots', () => {
    expect(redactPaths('spawn /usr/bin/magick ENOENT', [])).toBe('spawn /usr/bin/magick ENOENT');
  });
});

describe('redactPaths terminates on adversarial shapes', () => {
  const SHAPES: Record<string, string> = {
    'paths after brackets on one line': '/tmp/a x(/tmp/a ',
    'paths after equals signs on one line': '/tmp/a x=/tmp/a y',
    'unclosed quotes of each kind': `"/tmp/a '/tmp/a \`/tmp/a `,
    'closed quotes on one line': "'/tmp/a' ",
    'unclosed quotes on many lines': '"/tmp/a\n',
    'spaced names before a colon': '/tmp/a b c d: ',
    'spaces after a path with no colon': '/tmp/a' + ' b'.repeat(64),
    'roots without a lead': 'x/tmp/a',
    'one long path': '/tmp' + '/a'.repeat(64),
  };
  for (const [name, unit] of Object.entries(SHAPES)) {
    it(`${name}: a mebibyte is masked without hanging`, async () => {
      await expectNoHangOnInput(name, (text: string) => redactPaths(text, ROOTS), unit.repeat(Math.ceil(MIB / unit.length)));
    }, SCALING_TEST_TIMEOUT_MS);
  }
});

describe('serverPathRoots names the directories the servers use', () => {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin:relative/bin:',
    EASYCONVERT_STORAGE_DIR: '/var/lib/easyconvert/storage/',
    MAGICK_PATH: '/opt/easyconvert-missing/bin/magick',
    TESSDATA_PREFIX: '/srv/tessdata',
    FFMPEG_PATH: 'ffmpeg',
  };

  it('takes the temporary, working and storage directories, the configured tools and their install prefixes', () => {
    const roots = serverPathRoots(env);
    for (const root of [
      os.tmpdir(),
      process.cwd(),
      '/var/lib/easyconvert/storage',
      '/usr/local/bin',
      '/usr/local',
      '/usr/bin',
      '/usr',
      '/bin',
      '/opt/easyconvert-missing/bin',
      '/opt/easyconvert-missing',
      '/srv/tessdata',
    ]) {
      expect(roots, root).toContain(path.resolve(root));
    }
  });

  it('leaves out relative entries, the file system root and duplicates', () => {
    const roots = serverPathRoots(env);
    expect(roots.every((root) => path.isAbsolute(root) && root !== '/' && !root.endsWith('/'))).toBe(true);
    expect(roots).not.toContain('relative/bin');
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('masks a missing program under a configured tool directory', () => {
    expect(redactPaths(`spawn ${env.MAGICK_PATH} ENOENT`, serverPathRoots(env))).toBe('spawn *** ENOENT');
  });
});
