import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The font cache of the worker image (docs/policy-decisions.md, entry 385). The caches in `/var/cache/fontconfig` record the modification time
 * of each font directory to the nanosecond; the layers of an image keep whole seconds, so a cache built before the image was exported is
 * refused by every process that is not root, and each of them writes a new cache into its own home: 26 files and 0.12 s for every office
 * conversion, whose home is a new directory each time. The image is not built by the test run, so these checks read what the build is told:
 * the directories are set to whole seconds and the caches written in the same step that installs the fonts, and no later step adds a font.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const RUNNER = DOCKERFILE.slice(DOCKERFILE.indexOf(' AS runner'));
const VERIFY = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-worker-container.sh'), 'utf-8');

/** The `RUN` instruction (continuation lines joined) that installs the font packages. */
function fontInstallStep(): string {
  const start = RUNNER.indexOf('fonts-noto-cjk');
  expect(start).toBeGreaterThan(0);
  const begin = RUNNER.lastIndexOf('\nRUN ', start);
  const end = RUNNER.indexOf('\n\n', start);
  return RUNNER.slice(begin, end);
}

describe('the font cache of the worker image', () => {
  it('is written after the font directories are set to whole seconds, in the step that installs the fonts', () => {
    const step = fontInstallStep();
    const install = step.indexOf('apt-get install');
    const whole = step.indexOf('touch -d "@');
    const cache = step.indexOf('fc-cache -f -s');
    expect(install).toBeGreaterThan(0);
    expect(whole).toBeGreaterThan(install);
    expect(cache).toBeGreaterThan(whole);
    expect(step).toMatch(/find \/usr\/share\/fonts \/usr\/local\/share\/fonts -type d/);
  });

  it('is not made stale by a later step that adds a font', () => {
    const step = fontInstallStep();
    const after = RUNNER.slice(RUNNER.indexOf(step) + step.length)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(after).not.toMatch(/\/usr\/share\/fonts|\/usr\/local\/share\/fonts|fonts-[a-z]|fc-cache/);
  });

  it('is checked in the running container as the image user: no cache file is written into an empty home', () => {
    expect(VERIFY).toMatch(/fc-list/);
    expect(VERIFY).toMatch(/\.cache\/fontconfig/);
    expect(VERIFY).toMatch(/pass "the font caches of the image are read by the image user/);
  });
});
