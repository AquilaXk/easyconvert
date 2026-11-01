import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactPaths, scrubError } from '../src/lib/security/redact';
import { SERVER_PATH_ROOTS, STANDARD_PATH_ROOTS, maskFailure, serverPathRoots } from '../src/lib/security/server-paths';
import { SCALING_TEST_TIMEOUT_MS, expectNoHangOnInput } from './helpers/timing';

/**
 * A failure reason is stored and shown to support, so only the paths of the server's own directories are masked: the
 * standard top-level directories of the images, the temporary directory, the storage directory, the working directory and
 * the install directories of the engines. Every other slash (a PDF name, an end tag, a JSON pointer, a MIME type, a ratio,
 * a URL) is part of what went wrong, and so are the words after a path.
 */

const SPACED_ROOT = '/home/my user/app';
const ROOTS = [...STANDARD_PATH_ROOTS, '/usr/local', '/opt/easyconvert-missing', '/var/lib/easyconvert/storage', '/home/ubuntu/ec', SPACED_ROOT];
const MIB = 1024 * 1024;

const MASKED: Array<[string, string]> = [
  ['spawn /usr/bin/magick ENOENT', 'spawn *** ENOENT'],
  ['spawn /usr/bin/magick ENOENT: not found', 'spawn *** ENOENT: not found'],
  ['Sandboxed execution error: spawn /opt/easyconvert-missing/bin/magick ENOENT', 'Sandboxed execution error: spawn *** ENOENT'],
  ["ENOENT: no such file or directory, open '/tmp/ec-abc123/input.heic'", "ENOENT: no such file or directory, open '***'"],
  ['Error: Command failed: /usr/bin/ffmpeg -i /tmp/job-1/in.mp4 -y /tmp/job-1/out.webm', 'Error: Command failed: *** -i *** -y ***'],
  ['at Object.<anonymous> (/app/dist/worker.js:120:15)', 'at Object.<anonymous> (***:120:15)'],
  ['Cannot find module /app/dist/x.js imported from file:///app/dist/y.js', 'Cannot find module *** imported from file://***'],
  ['FILE:///tmp/a/b.pdf', 'FILE://***'],
  ['cwd:/var/lib/easyconvert/storage/jobs/7', 'cwd:***'],
  ['PATH=/usr/local/bin:/usr/bin:/bin', 'PATH=***:***:***'],
  ['cwd=/app, home=/home/easyconvert, tmp=/tmp, extra=/opt/ffmpeg/lib/x.so', 'cwd=***, home=***, tmp=***, extra=***'],
  ['open "/home/ubuntu/ec/tmp/a b/c.pdf"', 'open "***"'],
  ['/tmp/ec-xyz/한글.pdf: parse error', '***: parse error'],
  ['/tmp/ec-xyz/report (1).pdf: parse error', '*** (1).pdf: parse error'],
  ['/tmp/ec-xyz/report-1.pdf: parse error', '***: parse error'],
  ['Error: ffmpeg exited 1: /tmp/a/b.mp4: Invalid data found when processing input', 'Error: ffmpeg exited 1: ***: Invalid data found when processing input'],
  ['/tmp/my dir', '*** dir'],
  ['/tmp/ec-xyz/file name.pdf: parse error', '*** name.pdf: parse error'],
  ['open /tmp/foo bar/baz.pdf failed', 'open *** bar/baz.pdf failed'],
  ['error in /usr/bin/gs version 10.02: Unrecoverable error', 'error in *** version 10.02: Unrecoverable error'],
  ['Failed /usr/bin/convert 7.1.1: no decode delegate', 'Failed *** 7.1.1: no decode delegate'],
  ['spawn /usr/bin/magick ENOENT; see docs/ref.md', 'spawn *** ENOENT; see docs/ref.md'],
  ['Error: /usr/bin/pdftoppm -r 300 in.pdf out/page.png: exit 1', 'Error: *** -r 300 in.pdf out/page.png: exit 1'],
  ["ENOENT: no such file or directory, open '/tmp/ec-abc/my file'", "ENOENT: no such file or directory, open '***'"],
  ['"/home/my user/app" is missing', '"***" is missing'],
  ["can't open '/tmp/it's here.pdf' now", "can't open '***' now"],
  ["magick: unable to open image `/tmp/ec-1/my photo.heic' @ error", "magick: unable to open image `***' @ error"],
  ['open /home/my user/app/x.js failed', 'open *** failed'],
  ['Failed to convert /tmp/ec-1/in.heic using libheif: decoder error', 'Failed to convert *** using libheif: decoder error'],
  ['Could not open /tmp/job-1/out.pdf for writing: permission denied', 'Could not open *** for writing: permission denied'],
  ['pdftoppm /tmp/in.pdf is damaged (code: 3)', 'pdftoppm *** is damaged (code: 3)'],
  ['in /shared/storage/.staging/job-1/out.png (size: 12)', 'in *** (size: 12)'],
  ['stat /tmp/a.pdf then /tmp/b.pdf', 'stat *** then ***'],
  ['weird "/tmp/unclosed and more text: here', 'weird "*** and more text: here'],
  ['Error at /tmp/ec-1/file.xml:12:5: unexpected </note>', 'Error at ***:12:5: unexpected </note>'],
  ['Error at /tmp/ec-1/file.xml, line 4', 'Error at ***, line 4'],
  ['error in /usr/bin/convert: /usr/lib/foo.so not found', 'error in ***: *** not found'],
  ['Invalid use of /bin/sh -c "ls /tmp/a"', 'Invalid use of *** -c "ls ***"'],
  ['path=/tmp/x/y;/etc/passwd', 'path=***;***'],
  ['2>/tmp/err.log', '2>***'],
  ['cat x|/usr/bin/foo', 'cat x|***'],
  ['a;/tmp/x', 'a;***'],
  ['ENOENT /tmp\\/x', 'ENOENT ***'],
  ['Error loading shared library /usr/lib/x86_64-linux-gnu/libfoo.so.1: No such file', 'Error loading shared library ***: No such file'],
  ['error while loading shared libraries: /opt/ffmpeg/lib/libavcodec.so.61: cannot open shared object file', 'error while loading shared libraries: ***: cannot open shared object file'],
  ['Cannot run /opt/verapdf/verapdf: EACCES', 'Cannot run ***: EACCES'],
  ['djvused: /opt/djvulibre/bin/djvused: not found', 'djvused: ***: not found'],
  ['/etc/easyconvert/imagemagick/policy.xml: not readable', '***: not readable'],
  ['EACCES: permission denied, mkdir /srv/data/jobs/123', 'EACCES: permission denied, mkdir ***'],
  ['a user file named "/etc/passwd" was uploaded', 'a user file named "***" was uploaded'],
  ['/proc/self/fd/3', '***'],
  ['dir /tmp: missing', 'dir ***: missing'],
  ['magick: unable to open image `/tmp/w/in.psd\' @ error/blob.c/OpenBlob/3596.', "magick: unable to open image `***' @ error/blob.c/OpenBlob/3596."],
];

const KEPT: string[] = [
  'Invalid /Root entry in PDF trailer; missing /Pages /Kids /Type /Catalog',
  'Filter /FlateDecode failed; use /DCTDecode',
  'Unexpected end tag </div> at line 3; XML parse error: </note>',
  'Unexpected end tag </app> at line 3',
  'Unexpected end tag </tmp>',
  'JSON pointer /items/0/name is not a string',
  'text starting with slash: /dev/null; rate 3 /s',
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

  it('reads a root with a trailing slash as the directory', () => {
    expect(redactPaths('open /tmp/a and /tmp/', ['/tmp/'])).toBe('open *** and ***');
    expect(redactPaths('open /tmp/a and /tmp/', ['/tmp//'])).toBe('open *** and ***');
  });
});

describe('the worker image', () => {
  const dockerfile = fs.readFileSync(path.resolve(__dirname, '..', 'Dockerfile.worker'), 'utf-8');
  const installed = [...new Set(dockerfile.match(/\/opt\/[A-Za-z0-9._/-]+/g) ?? [])];
  const engineCopies = dockerfile
    .slice(dockerfile.indexOf(' AS runner'))
    .split('\n')
    .filter((line) => /^COPY --from=(?!builder\b)/.test(line))
    .map((line) => line.trim().split(/\s+/).at(-1) as string);
  const topSegment = (installPath: string) => `/${installPath.split('/')[1]}`;

  it('installs engines under /opt', () => {
    expect(installed.length).toBeGreaterThan(5);
  });

  it.each(installed)('a loader error naming %s is masked with the roots of this process', (installPath) => {
    expect(redactPaths(`error while loading ${installPath}: cannot open shared object file`, SERVER_PATH_ROOTS)).toBe(
      'error while loading ***: cannot open shared object file'
    );
  });

  it('puts every engine it copies in, and every /opt install directory, under a standard root', () => {
    expect(engineCopies.length).toBeGreaterThan(5);
    const outside = [...installed, ...engineCopies].filter((installPath) => !STANDARD_PATH_ROOTS.includes(topSegment(installPath)));
    expect(outside).toEqual([]);
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
    'words with inner slashes after a path': '/tmp/a' + ' b/c'.repeat(64),
    'file names after a path': '/tmp/a' + ' b/c.pdf'.repeat(64),
    'quoted spaced names without an extension': '"/tmp/a b c" ',
    'quotes followed by letters': "'/tmp/a'b",
    'backtick openers with apostrophes': "`/tmp/a'b",
    'apostrophes in a quoted name': "'/tmp/it's a'b'c ",
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes the standard directories, the temporary, working and storage directories, the configured tools and their install prefixes', () => {
    const roots = serverPathRoots(env);
    for (const root of [
      ...STANDARD_PATH_ROOTS,
      os.tmpdir(),
      process.cwd(),
      '/var/lib/easyconvert/storage',
      '/usr/local/bin',
      '/usr/local',
      '/usr/bin',
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

  it('keeps the other roots when the working directory is gone', () => {
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('ENOENT: process.cwd failed');
    });
    const roots = serverPathRoots({ PATH: env.PATH });
    expect(roots).toEqual(expect.arrayContaining([...STANDARD_PATH_ROOTS, '/usr/local/bin', '/usr/local']));
  });

  it('masks a missing program under a configured tool directory', () => {
    expect(redactPaths(`spawn ${env.MAGICK_PATH} ENOENT`, serverPathRoots(env))).toBe('spawn *** ENOENT');
  });
});

describe('a caught failure', () => {
  it('is masked in place and as the reason a job stores, with the same text', () => {
    const cause = new Error('open /opt/ffmpeg/lib/libavcodec.so.61 failed');
    const error = Object.assign(new Error('spawn /usr/bin/magick ENOENT: password=hunter2', { cause }), { path: '/usr/bin/magick' });

    expect(maskFailure(error)).toBe('spawn *** ENOENT: password=***');
    expect(error.message).toBe('spawn *** ENOENT: password=***');
    expect(error.path).toBe('***');
    expect(error.stack).not.toContain('hunter2');
    expect(error.stack).toContain('redact-paths.test');
    expect(cause.message).toBe('open *** failed');
  });

  it('masks only credentials without roots', () => {
    const error = new Error('spawn /usr/bin/magick ENOENT: password=hunter2');
    scrubError(error, []);
    expect(error.message).toBe('spawn /usr/bin/magick ENOENT: password=***');
  });

  it('gives the masked reason of an error that cannot be edited', () => {
    const error = Object.freeze(new Error('spawn /usr/bin/magick ENOENT'));
    expect(maskFailure(error)).toBe('spawn *** ENOENT');
  });
});
