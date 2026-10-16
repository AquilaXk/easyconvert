import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findMagickPolicyDirectory, MAGICK_POLICY_DIR_ENV } from '../src/lib/conversions/image-magick-cli';
import { MAGICK_BINARY } from './helpers/imagemagick';
import { skipUnless } from './helpers/strict-skip';

/**
 * The policy every ImageMagick run of the picture decoders is started under (docker/imagemagick/policy.xml, named by
 * MAGICK_CONFIGURE_PATH): all coders and delegates denied except the ones the route calls, no `@` file lists, and resource
 * limits. The tests run the installed ImageMagick (6.9 or 7.1) under it with coders the route never calls and read what
 * `-list policy` reports; the run of the route itself is in image-external-decode.test.ts.
 */

const POLICY_DIRECTORY = path.join(__dirname, '..', 'docker', 'imagemagick');
const needsMagick = skipUnless('ImageMagick (magick or convert)', MAGICK_BINARY !== null);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magick-policy-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

function run(args: readonly string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(MAGICK_BINARY as string, args, {
    cwd: workDir,
    env: { ...process.env, MAGICK_CONFIGURE_PATH: POLICY_DIRECTORY },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

/** The rules of the first policy file in `-list policy`, as `Domain rights pattern` (a resource as `Resource name value`). */
function repositoryRules(): string[] {
  const listing = run(['-list', 'policy']).stdout;
  const section = listing.split(/\n(?=Path: )/).find((part) => part.startsWith(`Path: ${POLICY_DIRECTORY}`)) ?? '';
  return section
    .split(/\n(?=\s+Policy: )/)
    .slice(1)
    .map((rule) => {
      const field = (name: string): string => new RegExp(`^\\s+${name}:\\s*(.*?)\\s*$`, 'm').exec(rule)?.[1] ?? '';
      const domain = /Policy:\s*(\w+)/.exec(rule)?.[1] ?? '';
      return domain === 'Resource' ? `Resource ${field('name')} ${field('value')}` : `${domain} ${field('rights').replace(/[|\s]+/g, ' ').trim()} ${field('pattern')}`;
    });
}

describe.skipIf(needsMagick)('the ImageMagick policy of the decoders', () => {
  it('is listed first, with every coder and delegate denied and the route coders allowed after them', () => {
    const rules = repositoryRules();
    const at = (rule: string): number => rules.indexOf(rule);
    expect(at('Delegate None *')).toBeGreaterThanOrEqual(0);
    expect(at('Path None @*')).toBeGreaterThanOrEqual(0);
    expect(at('Coder None *')).toBeGreaterThanOrEqual(0);
    expect(rules).toContain('Coder Read {PSD,XCF,TGA,PCX,DDS,PNM,PBM,PGM,PPM,PAM,HEIC,HEIF}');
    expect(rules).toContain('Coder Read Write {TIFF,PNG,INFO}');
    // A later rule overrides an earlier one, so the denial comes first.
    expect(at('Coder None *')).toBeLessThan(at('Coder Read {PSD,XCF,TGA,PCX,DDS,PNM,PBM,PGM,PPM,PAM,HEIC,HEIF}'));
    expect(at('Coder None *')).toBeLessThan(at('Coder Read Write {TIFF,PNG,INFO}'));
  });

  it('limits width, height, area, memory, map, disk, list length, threads and time', () => {
    const limits = Object.fromEntries(repositoryRules().filter((rule) => rule.startsWith('Resource ')).map((rule) => rule.split(' ').slice(1)));
    expect(limits).toEqual({ width: '100KP', height: '100KP', area: '1GiB', memory: '1GiB', map: '2GiB', disk: '2GiB', 'list-length': '4096', thread: '2', time: '100' });
  });

  it.each([
    ['a drawing script (MVG)', 'mvg:script.mvg'],
    ['a scripting file (MSL)', 'msl:script.msl'],
    ['a text listing', 'text:note.txt'],
    ['a generated label', 'label:hello'],
    ['a generated canvas', 'xc:red'],
    ['a file named by a list (@)', '@list.txt'],
    ['an address', 'https://127.0.0.1:9/picture.png'],
  ])('refuses %s', (_label, input) => {
    fs.writeFileSync(path.join(workDir, 'script.mvg'), 'push graphic-context\nviewbox 0 0 10 10\nfill red\nrectangle 0,0 9,9\npop graphic-context\n');
    fs.writeFileSync(path.join(workDir, 'script.msl'), '<?xml version="1.0"?><image><read filename="xc:red"/><write filename="msl-out.png"/></image>');
    fs.writeFileSync(path.join(workDir, 'note.txt'), '0,0: (255,0,0) red\n');
    fs.writeFileSync(path.join(workDir, 'list.txt'), 'xc:blue\n');
    const output = path.join(workDir, `refused-${path.basename(input).replace(/\W/g, '_')}.png`);
    const result = run([input, output]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/security policy|not authorized|not allowed/i);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'msl-out.png'))).toBe(false);
  });

  it('reads and writes the coders of the route', () => {
    fs.writeFileSync(path.join(workDir, 'in.pnm'), Buffer.concat([Buffer.from('P6\n2 1\n255\n'), Buffer.from([255, 0, 0, 0, 0, 255])]));
    const result = run(['pnm:in.pnm', 'png:out.png']);
    expect(result.status).toBe(0);
    expect(execFileSync(MAGICK_BINARY as string, ['out.png', '-format', '%w %h', 'info:'], { cwd: workDir, encoding: 'utf8', env: { ...process.env, MAGICK_CONFIGURE_PATH: POLICY_DIRECTORY } })).toBe('2 1');
  });

  it('refuses a picture wider than the limit and reads one at the limit', () => {
    const grey = (width: number): Buffer => Buffer.concat([Buffer.from(`P5\n${width} 1\n255\n`), Buffer.alloc(width)]);
    fs.writeFileSync(path.join(workDir, 'wide.pgm'), grey(100_001));
    const refused = run(['pnm:wide.pgm', 'png:wide.png']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/width|height|exceed|limit|resource/i);
    fs.writeFileSync(path.join(workDir, 'limit.pgm'), grey(100_000));
    expect(run(['pnm:limit.pgm', 'png:limit.png']).status).toBe(0);
  });
});

describe('where the policy is looked for', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-dirs-'));
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'policy.xml'), '<policymap/>');
  const emptyDirectory = path.join(directory, 'empty');
  fs.mkdirSync(emptyDirectory);

  it('takes the directory the variable names when it holds a policy', () => {
    expect(findMagickPolicyDirectory({ [MAGICK_POLICY_DIR_ENV]: directory })).toBe(directory);
  });

  it.each([
    ['a relative path', path.relative(process.cwd(), directory)],
    ['a directory without a policy', emptyDirectory],
    ['a directory that does not exist', path.join(directory, 'missing')],
  ])('answers null for %s, without looking anywhere else', (_label, value) => {
    expect(findMagickPolicyDirectory({ [MAGICK_POLICY_DIR_ENV]: value })).toBeNull();
  });

  it('uses the repository directory when the variable is unset or empty', () => {
    expect(findMagickPolicyDirectory({})).toBe(POLICY_DIRECTORY);
    expect(findMagickPolicyDirectory({ [MAGICK_POLICY_DIR_ENV]: '' })).toBe(POLICY_DIRECTORY);
  });
});
