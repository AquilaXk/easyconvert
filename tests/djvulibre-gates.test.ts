import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { skipUnless } from './helpers/strict-skip';

/**
 * The checks of scripts/lib/djvulibre-gates.sh that scripts/install-djvulibre.sh runs on the output of other programs: the download of the
 * pinned source, the pixels of two PDFs and the status of ddjvu on the chain whose threads cannot all start. The functions are sourced into a
 * bash process and run for real; curl, pdftoppm, timeout, prlimit and ddjvu are stand-ins on the PATH that serve, render and end the way the
 * case needs, because a download that fails, a rendering that differs and a ddjvu that crashes at exit cannot be had from the real programs on demand.
 * The real ones run in the image stage and in CI, which build the same script.
 */

const ROOT = path.resolve(__dirname, '..');
const GATES = path.join(ROOT, 'scripts', 'lib', 'djvulibre-gates.sh');
const sha256sum = spawnSync('sha256sum', ['--version'], { encoding: 'utf-8' }).status === 0;
const SKIP = skipUnless('sha256sum', sha256sum);

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'djvulibre-gates-'));
  temps.push(dir);
  return dir;
}

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `snippet` after sourcing the gates, with the stand-ins first on the PATH. */
function run(bin: string, snippet: string, env: Record<string, string> = {}): Outcome {
  const result = spawnSync('bash', ['-c', `source "${GATES}"\n${snippet}`], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('fetch_checked', () => {
  const ARCHIVE = 'djvulibre_3.5.28.orig.tar.xz';
  const GOOD = 'the pinned archive';
  const FIRST = 'https://first.example/pool';
  const SECOND = 'https://second.example/pool';

  /** A curl that serves `<root>/<host>/<name>` for the URL it is given, fails like `--fail` on a missing file, and logs its arguments. */
  function fixture(served: Record<string, string>): { bin: string; work: string; log: string } {
    const dir = scratch();
    const bin = path.join(dir, 'bin');
    const root = path.join(dir, 'served');
    const work = path.join(dir, 'work');
    const log = path.join(dir, 'curl.log');
    for (const dirName of [bin, work]) mkdirSync(dirName);
    for (const [source, content] of Object.entries(served)) {
      const url = new URL(`${source}/${ARCHIVE}`);
      mkdirSync(path.join(root, url.host), { recursive: true });
      writeFileSync(path.join(root, url.host, ARCHIVE), content);
    }
    stub(
      bin,
      'curl',
      `echo "$*" >> "${log}"
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done
host="\${url#https://}"; host="\${host%%/*}"
[ -f "${root}/$host/${ARCHIVE}" ] || exit 22
cp "${root}/$host/${ARCHIVE}" "$out"`
    );
    return { bin, work, log };
  }

  const fetch = (bin: string, work: string) => run(bin, `fetch_checked "${work}" "${ARCHIVE}" "${sha256Of(GOOD)}" "${FIRST}" "${SECOND}"`);

  it.skipIf(SKIP)('takes the archive from the first source that serves the bytes of the pinned digest, and prints that source', () => {
    const { bin, work, log } = fixture({ [FIRST]: GOOD, [SECOND]: GOOD });
    const outcome = fetch(bin, work);
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(outcome.stdout.trim()).toBe(FIRST);
    expect(readFileSync(path.join(work, ARCHIVE), 'utf-8')).toBe(GOOD);
    const calls = readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`--proto =https --tlsv1.2 --fail`);
    expect(calls[0]).toContain(`${FIRST}/${ARCHIVE}`);
  });

  it.skipIf(SKIP)('goes on to the next source when the first serves other bytes, and says which source did not', () => {
    const { bin, work } = fixture({ [FIRST]: 'bytes of another file', [SECOND]: GOOD });
    const outcome = fetch(bin, work);
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(outcome.stdout.trim()).toBe(SECOND);
    expect(readFileSync(path.join(work, ARCHIVE), 'utf-8')).toBe(GOOD);
    expect(outcome.stderr).toContain(`${FIRST}/${ARCHIVE} did not give the file of SHA-256 ${sha256Of(GOOD)}`);
  });

  it.skipIf(SKIP)('goes on to the next source when the first cannot be reached', () => {
    const { bin, work } = fixture({ [SECOND]: GOOD });
    const outcome = fetch(bin, work);
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(outcome.stdout.trim()).toBe(SECOND);
  });

  it.skipIf(SKIP)('fails, naming every source, and leaves no file behind when none serves the pinned bytes', () => {
    const { bin, work } = fixture({ [FIRST]: 'bytes of another file', [SECOND]: 'and other bytes' });
    const outcome = fetch(bin, work);
    expect(outcome.status).toBe(1);
    expect(outcome.stdout.trim()).toBe('');
    expect(outcome.stderr).toContain(`${FIRST}/${ARCHIVE} did not give`);
    expect(outcome.stderr).toContain(`${SECOND}/${ARCHIVE} did not give`);
    expect(existsSync(path.join(work, ARCHIVE))).toBe(false);
  });
});

describe('same_pixels', () => {
  /** A pdftoppm that renders the "PDF" `pages=<n>` / `pixels=<text>` / `except=<page>:<text>` into one PPM of text for each page. */
  function renderer(): { bin: string; dir: string } {
    const dir = scratch();
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    stub(
      bin,
      'pdftoppm',
      `pdf="$3"; prefix="$4"
pages="$(sed -n 's/^pages=//p' "$pdf")"; pixels="$(sed -n 's/^pixels=//p' "$pdf")"; except="$(sed -n 's/^except=//p' "$pdf")"
for ((page = 1; page <= pages; page++)); do
  text="$pixels"
  if [ "\${except%%:*}" = "$page" ]; then text="\${except#*:}"; fi
  printf '%s' "$text-$page" > "$prefix-$page.ppm"
done`
    );
    return { bin, dir };
  }

  const pdf = (dir: string, name: string, pages: number, pixels: string, except = ''): string => {
    const file = path.join(dir, name);
    writeFileSync(file, `pages=${pages}\npixels=${pixels}\n${except ? `except=${except}\n` : ''}`);
    return file;
  };

  it('accepts two PDFs that render to the expected number of pages with the same pixels', () => {
    const { bin, dir } = renderer();
    const outcome = run(bin, `same_pixels "${pdf(dir, 'a.pdf', 3, 'ink')}" "${pdf(dir, 'b.pdf', 3, 'ink')}" 3`);
    expect(outcome.status, outcome.stderr).toBe(0);
  });

  it('fails, naming the page, when one page of the second PDF renders to other pixels', () => {
    const { bin, dir } = renderer();
    const outcome = run(bin, `same_pixels "${pdf(dir, 'a.pdf', 3, 'ink')}" "${pdf(dir, 'b.pdf', 3, 'ink', '2:smudge')}" 3`);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('page-2.ppm differs');
    expect(outcome.stderr).not.toContain('page-1.ppm differs');
  });

  it('fails, naming the PDF, when it renders to fewer pages than the document lists', () => {
    const { bin, dir } = renderer();
    const reference = pdf(dir, 'reference.pdf', 2, 'ink');
    const outcome = run(bin, `same_pixels "${pdf(dir, 'a.pdf', 3, 'ink')}" "${reference}" 3`);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain(`${reference} rendered to 2 pages, not 3`);
  });

  it('fails when both PDFs render to the same pixels but not to the number of pages expected', () => {
    const { bin, dir } = renderer();
    const outcome = run(bin, `same_pixels "${pdf(dir, 'a.pdf', 2, 'ink')}" "${pdf(dir, 'b.pdf', 2, 'ink')}" 3`);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('rendered to 2 pages, not 3');
  });
});

describe('thread_gate', () => {
  const DECODE_FAILED = 'Decode of an included file failed';
  const TRANSLATED = 'Dekodierung einer eingebundenen Datei fehlgeschlagen';

  /**
   * A ddjvu that ends with STUB_STATUS, printing the decode failure in English under LANGUAGE=C and translated under any other language
   * (as the program does with its catalogues) when STUB_MESSAGE is set, and logs what it saw; timeout and prlimit run what follows their options.
   */
  function toolbox(): { bin: string; dir: string; log: string } {
    const dir = scratch();
    const bin = path.join(dir, 'bin');
    const log = path.join(dir, 'tools.log');
    mkdirSync(bin);
    stub(bin, 'timeout', `echo "timeout $1 $2" >> "${log}"; shift 2; exec "$@"`);
    stub(bin, 'prlimit', `echo "prlimit $1 $2" >> "${log}"; shift 2; exec "$@"`);
    stub(
      bin,
      'ddjvu',
      `echo "ddjvu $* LANGUAGE=$LANGUAGE LC_ALL=$LC_ALL stack=$(ulimit -s) arena=$MALLOC_ARENA_MAX" >> "${log}"
if [ -n "\${STUB_MESSAGE:-}" ]; then if [ "$LANGUAGE" = C ]; then echo "${DECODE_FAILED}" >&2; else echo "${TRANSLATED}" >&2; fi; fi
exit "$STUB_STATUS"`
    );
    return { bin, dir, log };
  }

  const gate = (bin: string, dir: string, env: Record<string, string>) =>
    run(bin, `thread_gate ddjvu "${dir}/chain.djvu" "${dir}/chain.pdf" "${dir}/stderr"`, env);

  it.each([
    ['10', 'the decode failure', true],
    ['139', 'the decode failure, then the crash at exit', true],
  ])('accepts status %s with %s', (status, _what, message) => {
    const { bin, dir } = toolbox();
    const outcome = gate(bin, dir, { STUB_STATUS: status, ...(message ? { STUB_MESSAGE: '1' } : {}) });
    expect(outcome.status, outcome.stderr).toBe(0);
  });

  it.each(['10', '139'])('refuses status %s without the decode failure on stderr, and shows what the run printed', (status) => {
    const { bin, dir } = toolbox();
    const outcome = gate(bin, dir, { STUB_STATUS: status });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain(`ddjvu ended with status ${status} on a chain whose threads cannot all start, without the decode failure`);
  });

  it.each(['124', '137'])('refuses status %s, a hang, as a build without the thread patch, and shows what the run printed', (status) => {
    const { bin, dir } = toolbox();
    const outcome = gate(bin, dir, { STUB_STATUS: status, STUB_MESSAGE: '1' });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain(`ddjvu was stopped with status ${status} on a chain whose threads cannot all start: the thread patch is not in the build`);
    expect(outcome.stderr).toContain(DECODE_FAILED);
  });

  it.each(['0', '1'])('refuses any other status, such as %s', (status) => {
    const { bin, dir } = toolbox();
    const outcome = gate(bin, dir, { STUB_STATUS: status, STUB_MESSAGE: '1' });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain(`ddjvu ended with status ${status} on a chain whose threads cannot all start:`);
  });

  it('looks for the English text in the English language whatever language the caller runs in', () => {
    const { bin, dir, log } = toolbox();
    const outcome = gate(bin, dir, { STUB_STATUS: '10', STUB_MESSAGE: '1', LANGUAGE: 'de', LC_ALL: 'de_DE.UTF-8', LC_MESSAGES: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' });
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(readFileSync(log, 'utf-8')).toContain('LANGUAGE=C LC_ALL=C.UTF-8');
  });

  it('runs the chain under the address space, the stack and the time limit of the gate, with one malloc arena', () => {
    const { bin, dir, log } = toolbox();
    const outcome = gate(bin, dir, { STUB_STATUS: '10', STUB_MESSAGE: '1' });
    expect(outcome.status, outcome.stderr).toBe(0);
    const calls = readFileSync(log, 'utf-8');
    expect(calls).toContain('timeout --signal=KILL 10');
    expect(calls).toContain(`prlimit --as=${512 * 1024 * 1024}`);
    expect(calls).toContain(`ddjvu -format=pdf ${dir}/chain.djvu ${dir}/chain.pdf`);
    expect(calls).toContain('stack=8192');
    expect(calls).toContain('arena=1');
  });
});
