import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The font cache of the worker image (docs/policy-decisions.md, entry 385). The caches in `/var/cache/fontconfig` record the modification time
 * of each font directory to the nanosecond; the layers of an image keep whole seconds, so a cache built before the image was exported is
 * refused by every process that is not root, and each of them writes a new cache into its own home: 26 files and 0.12 s for every office
 * conversion, whose home is a new directory each time. The image is not built by the test run, so these checks read what the build is told:
 * the directories are set to whole seconds and the caches written in the last step that runs as root, so no later step can leave one stale.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const RUNNER = DOCKERFILE.slice(DOCKERFILE.indexOf(' AS runner'));
const VERIFY = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-worker-container.sh'), 'utf-8');

/** The last `RUN` instruction of the runner stage, continuation lines joined. */
function lastRunStep(): string {
  const start = RUNNER.lastIndexOf('\nRUN ');
  const end = RUNNER.indexOf('\n\n', start);
  return RUNNER.slice(start, end === -1 ? undefined : end);
}

describe('the font cache of the worker image', () => {
  it('is written by the last step that runs as root, after the directories are set to whole seconds', () => {
    const step = lastRunStep();
    const whole = step.indexOf('touch -d "@');
    const cache = step.indexOf('fc-cache -f -s');
    expect(whole).toBeGreaterThan(0);
    expect(cache).toBeGreaterThan(whole);
    expect(step).toMatch(/find -L \/usr\/share\/fonts \/usr\/local\/share\/fonts -type d/);
    expect(RUNNER.indexOf('USER easyconvert:easyconvert')).toBeGreaterThan(RUNNER.lastIndexOf('\nRUN '));
  });

  it('is written once, after the last step that installs a package', () => {
    const writes = RUNNER.split('\n').filter((line) => /^\s*&& fc-cache /.test(line));
    expect(writes).toEqual(['    && fc-cache -f -s']);
    expect(RUNNER.indexOf('&& fc-cache -f -s')).toBeGreaterThan(RUNNER.lastIndexOf('apt-get install'));
    expect(RUNNER.indexOf('&& fc-cache -f -s')).toBeGreaterThan(RUNNER.indexOf('fonts-noto-cjk'));
  });

  it('is checked in the running container as the image user: no cache file is written into an empty home', () => {
    expect(VERIFY).toMatch(/fc-list/);
    expect(VERIFY).toMatch(/\.cache\/fontconfig/);
    expect(VERIFY).toMatch(/pass "the font caches of the image are read by the image user/);
  });
});
