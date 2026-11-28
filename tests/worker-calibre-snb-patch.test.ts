import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The SNB reader fix of calibre (docs/policy-decisions.md, entry 465): upstream's change to `snbfile.py` is applied to the calibre 8.5.0 of the
 * worker image while it is built. The patch is not run here (calibre's source is not part of this repository); what is held is the file as
 * upstream wrote it, the build step that applies it, and that the step cannot pass over a patch that does not apply.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf-8');
const patch = read('scripts', 'calibre-patches', 'snb-entry-names-as-text.patch');
const dockerfile = read('Dockerfile.worker');
const verifyScript = read('scripts', 'verify-worker-container.sh');
const UPSTREAM_COMMIT = 'c33f0a54bd63ac25fb3009ab5ac587a62dacfd80';

/** The instruction of the Dockerfile that runs after the `COPY` of the patch directory, up to the next blank line. */
function snbPatchStep(): string {
  const start = dockerfile.indexOf('COPY scripts/calibre-patches /tmp/calibre-patches');
  expect(start).toBeGreaterThan(0);
  return dockerfile.slice(start, dockerfile.indexOf('\n\n', start));
}

describe('scripts/calibre-patches/snb-entry-names-as-text.patch', () => {
  it('names the upstream commit, its licence and the first release that has it', () => {
    expect(patch).toMatch(new RegExp(`https://github\\.com/kovidgoyal/calibre/commit/${UPSTREAM_COMMIT}`));
    expect(patch).toMatch(/Licence:\s+GPL-3\.0 /);
    expect(patch).toMatch(/first released in v9\.10\.0/);
  });

  it('is the one change to snbfile.py: the entry names are decoded to text, and the writer encodes them where the container needs bytes', () => {
    const changed = patch.split('\n').filter((line) => /^[+-][^+-]/.test(line)).map((line) => `${line[0]}${line.slice(1).trim()}`);
    expect(changed).toEqual([
      '-f.fileName = fileNames[i]',
      '+# Decode to str so lookups against str keys match (see GetFileStream)',
      "+f.fileName = fileNames[i].decode('utf-8', 'replace')",
      '-if isinstance(f.fileName, str):',
      "-f.fileName = f.fileName.encode('ascii', 'ignore')",
      '-if isinstance(f.fileName, str):',
      "-f.fileName = f.fileName.encode('ascii', 'ignore')",
      "-fileNameTable += (f.fileName + b'\\0')",
      "+fileNameTable += f.fileName.encode('ascii', 'ignore') + b'\\0'",
    ]);
    expect(patch.match(/^diff --git /gm)).toHaveLength(1);
    expect(patch).toMatch(/^diff --git a\/src\/calibre\/ebooks\/snb\/snbfile\.py b\/src\/calibre\/ebooks\/snb\/snbfile\.py$/m);
  });

  it('carries no trailer that names the tool that wrote the upstream commit', () => {
    expect(patch).not.toMatch(/Co-Authored-By|Generated with/i);
  });
});

describe('the SNB step of Dockerfile.worker', () => {
  const step = snbPatchStep();

  it('finds the installed file from the package, and applies the patch with no fuzz, no leftover file and a failure when it does not apply', () => {
    expect(step).toMatch(/dpkg -L calibre \| grep -E '\/calibre\/ebooks\/snb\/snbfile\\\.py\$'/);
    expect(step).toMatch(/patch --batch --forward --fuzz=0 --no-backup-if-mismatch --reject-file=- "\$\{snbfile\}" \/tmp\/calibre-patches\/snb-entry-names-as-text\.patch/);
    expect(step).not.toMatch(/patch [^\n]*\|\| (true|:)/);
  });

  it('skips the patch from calibre 9.10 with a message and not otherwise', () => {
    expect(step).toMatch(/if dpkg --compare-versions "\$\{calibre_version\}" ge 9\.10; then \\\n\s+echo "calibre \$\{calibre_version\} has the SNB reader fix \(9\.10\.0\): the patch is skipped"; \\\n\s+else/);
  });

  it('removes the patch tool again and keeps the patch beside the licence of the program', () => {
    expect(step).toMatch(/apt-get install -y --no-install-recommends patch/);
    expect(step).toMatch(/apt-get purge -y patch/);
    expect(step).toMatch(/install -D -m 0644 \/tmp\/calibre-patches\/snb-entry-names-as-text\.patch \/usr\/share\/doc\/calibre\/patches\/snb-entry-names-as-text\.patch/);
  });

  it('writes an SNB book with calibre and reads it back to EPUB and text, each checked', () => {
    expect(step).toMatch(/ebook-convert "\$\{scratch\}\/book\.txt" "\$\{scratch\}\/book\.snb"/);
    expect(step).toMatch(/for target in epub txt; do/);
    expect(step).toMatch(/test "\$\(head -c 8 "\$\{scratch\}\/book\.snb"\)" = 'SNBP000B'/);
    expect(step).toMatch(/mimetypeapplication\/epub\+zip/);
    expect(step).toMatch(/grep -q 'Sample text' "\$\{scratch\}\/book-from-snb\.txt"/);
  });
});

describe('scripts/verify-worker-container.sh', () => {
  it('reads an SNB book inside the sandbox and fails when the reader finds no entry of it', () => {
    expect(verifyScript).toMatch(/ebook-convert "\$work_dir\/book\.txt" "\$work_dir\/book\.snb"/);
    expect(verifyScript).toMatch(/for calibre_target in epub txt; do\n\s+\[ -n "\$calibre_snb_failure" \] && break/);
    expect(verifyScript).toMatch(/fail "calibre did not read an SNB book inside the sandbox: \$calibre_snb_failure"/);
  });
});
