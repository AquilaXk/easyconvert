import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The worker image overwrites the distribution's ImageMagick policy file with the repository's, so that no file read after it
 * can allow a coder again, and its build fails unless `verify-imagemagick-policy` finds that ImageMagick reads no other policy
 * file and that no file allows more than ours. The Dockerfile step is pinned as text (no Docker here); the script is run against
 * a stand-in for `magick -list policy` that prints the listings of an image that is right and of images that are not.
 */

const ROOT = path.join(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf8');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-imagemagick-policy.sh');
const POLICY_DIR = '/etc/easyconvert/imagemagick';

describe('the Dockerfile step that fixes the ImageMagick policy', () => {
  it('installs the repository policy read-only and the verification script', () => {
    expect(DOCKERFILE).toContain(`COPY --chmod=0444 docker/imagemagick/policy.xml ${POLICY_DIR}/policy.xml`);
    expect(DOCKERFILE).toContain('COPY --chmod=0555 scripts/verify-imagemagick-policy.sh /usr/local/bin/verify-imagemagick-policy');
  });

  it('makes the policy directories searchable before the copy, which would give them the mode of the file', () => {
    const directories = DOCKERFILE.indexOf(`RUN install -d -o root -g root -m 0555 /etc/easyconvert ${POLICY_DIR}`);
    expect(directories).toBeGreaterThan(-1);
    expect(directories).toBeLessThan(DOCKERFILE.indexOf(`COPY --chmod=0444 docker/imagemagick/policy.xml ${POLICY_DIR}/policy.xml`));
  });

  it('verifies the policy again as the user the application runs as', () => {
    expect(DOCKERFILE).toContain(`&& runuser -u easyconvert -- verify-imagemagick-policy "\${MAGICK}" ${POLICY_DIR}`);
  });

  it('overwrites every distribution policy file with ours, then verifies, in one step that fails the build', () => {
    const step = DOCKERFILE.split('\n\n').find((block) => block.includes('verify-imagemagick-policy "')) ?? '';
    const overwrite = step.indexOf(`cp ${POLICY_DIR}/policy.xml "\${policy}"`);
    const verify = step.indexOf(`verify-imagemagick-policy "\${MAGICK}" ${POLICY_DIR}`);
    expect(step).toContain('for policy in /etc/ImageMagick-*/policy.xml; do if [ -e "${policy}" ]; then');
    expect(overwrite).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(overwrite);
    expect(step.startsWith('# Decoders of the picture formats')).toBe(true);
    expect(step).toMatch(/\bRUN MAGICK=.*\\\n(?:\s+&& .*\\\n)*\s+&& dpkg-query/);
  });
});

describe('verify-imagemagick-policy', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-policy-'));
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
  let count = 0;

  const rule = (domain: string, rights: string, pattern: string): string => `  Policy: ${domain}\n    rights: ${rights} \n    pattern: ${pattern}\n`;
  const ours = `Path: ${POLICY_DIR}/policy.xml\n${rule('Delegate', 'None', '*')}${rule('Coder', 'None', '*')}${rule('Coder', 'Read', '{PSD,XCF}')}${rule('Coder', 'Read Write', '{TIFF,PNG,INFO}')}\n`;
  const builtIn = 'Path: [built-in]\n  Policy: Undefined\n    rights: None \n';

  /** Runs the script against a stand-in `magick` that prints `listing` for `-list policy`. */
  function verify(listing: string): { status: number | null; stderr: string; stdout: string } {
    const stub = path.join(directory, `magick-${count++}`);
    fs.writeFileSync(stub, `#!/bin/sh\ncat <<'LISTING'\n${listing}LISTING\n`, { mode: 0o755 });
    return spawnSync('sh', [SCRIPT, stub, POLICY_DIR], { encoding: 'utf8' });
  }

  it('accepts an image that lists our file, the distribution file overwritten with it, and the built-in policy', () => {
    const distribution = ours.replace(`${POLICY_DIR}/policy.xml`, '/etc/ImageMagick-7/policy.xml');
    for (const listing of [ours + builtIn, ours + distribution + builtIn, ours]) {
      const result = verify(listing);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('2 allow rules, all ours');
    }
  });

  it('accepts a distribution file that only denies more', () => {
    const stricter = `Path: /etc/ImageMagick-7/policy.xml\n${rule('Coder', 'None', '{PDF,PS}')}`;
    expect(verify(ours + stricter + builtIn).status).toBe(0);
  });

  it.each([
    ['a policy file elsewhere', 'Path: /home/user/.config/ImageMagick/policy.xml'],
    ['a policy file of another version', 'Path: /etc/ImageMagick-8/policy.xml'],
    ['a path that only starts like ours', `Path: ${POLICY_DIR}/policy.xml.bak`],
  ])('refuses %s', (_label, header) => {
    const result = verify(`${ours}${header}\n${rule('Coder', 'None', '*')}${builtIn}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not ours');
    expect(result.stderr).toContain(header);
  });

  it.each([
    ['a coder', rule('Coder', 'Read', 'MVG')],
    ['a delegate', rule('Delegate', 'Read Write', '*')],
    ['a path', rule('Path', 'Read', '@*')],
    ['a coder with more rights than ours', rule('Coder', 'Read Write', '{PSD,XCF}')],
  ])('refuses a distribution file that allows %s that ours does not', (_label, allowing) => {
    const result = verify(`${ours}Path: /etc/ImageMagick-7/policy.xml\n${rule('Coder', 'None', '*')}${allowing}${builtIn}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('allows what the repository policy does not');
  });

  it('refuses a listing that does not hold our file', () => {
    const result = verify(`Path: /etc/ImageMagick-7/policy.xml\n${rule('Coder', 'None', '*')}${builtIn}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not list the repository policy');
  });
});
