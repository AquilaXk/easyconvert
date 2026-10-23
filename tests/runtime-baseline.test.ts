import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The runtime baseline is Node.js 24 (active LTS) on Debian 13 (trixie), in the worker image, in CI and in the
 * package metadata alike (QA decision 2026-10-10, issues 682 and 679). The expectations are written out here, not
 * read from the files under test, so a file that drifts back to an older runtime fails against this baseline.
 */

const ROOT = path.resolve(__dirname, '..');
const NODE_MAJOR = 24;
const read = (...segments: string[]): string => readFileSync(path.join(ROOT, ...segments), 'utf-8');

const dockerfile = read('Dockerfile.worker');
const stages = parseDockerfile(dockerfile);
const NODE_IMAGE_PIN = /^node:24\.\d+\.\d+-trixie-slim@sha256:[0-9a-f]{64}$/;

describe('Dockerfile.worker base image', () => {
  const declared = /^ARG NODE_IMAGE=(\S+)$/m.exec(dockerfile)?.[1];

  it('pins one exact Node.js 24 trixie-slim tag together with its multi-architecture digest', () => {
    expect(declared, 'ARG NODE_IMAGE declared before the first stage').toMatch(NODE_IMAGE_PIN);
    expect(dockerfile.indexOf('ARG NODE_IMAGE=')).toBeLessThan(dockerfile.indexOf('FROM '));
  });

  it('builds every stage from that single pinned image, the qpdf job runner stage included, except the build of sharp libvips', () => {
    // Six stages: builder, sevenzip, libredwg, cadconvert, qpdfrunner (compiles the runner against the libc of the runtime image) and runner.
    // sharp's libvips is built in the upstream build container of its own release, pinned by digest, and only its library is copied
    // out (docs/policy-decisions.md, entry 81); the library needs glibc 2.28, which the runtime image has.
    const node = stages.filter((stage) => !stage.name.startsWith('sharplibvips'));
    expect(node.map((stage) => stage.name)).toEqual(['builder', 'sevenzip', 'libredwg', 'cadconvert', 'qpdfrunner', 'runner']);
    expect(node.map((stage) => stage.baseImage)).toEqual(Array(6).fill('${NODE_IMAGE}'));
    const libvips = stages.filter((stage) => stage.name.startsWith('sharplibvips'));
    expect(libvips.map((stage) => stage.name)).toEqual(['sharplibvips-build', 'sharplibvips']);
    expect(libvips[0].baseImage).toMatch(/^rockylinux\/rockylinux:8-ubi-init@sha256:[0-9a-f]{64}$/);
    expect(libvips[1].baseImage).toBe('scratch');
  });

  it('names no Debian 12 release or Node.js 20 base image any more', () => {
    expect(dockerfile).not.toMatch(/bookworm/i);
    expect(dockerfile).not.toMatch(/node:20/);
  });

  it('installs the libavif command-line tools that the worker finds at /usr/bin/avifenc', () => {
    const runner = stages.find((stage) => stage.name === 'runner');
    const install = runner?.instructions.find((instruction) => /apt-get install/.test(instruction.argument));
    expect(install?.argument).toMatch(/\blibavif-bin\b/);
  });
});

describe('package metadata and build targets', () => {
  const manifest = JSON.parse(read('package.json')) as { engines: { node: string }; scripts: Record<string, string> };

  it('requires Node.js 24 or newer', () => {
    expect(manifest.engines.node).toBe(`>=${NODE_MAJOR}.0.0`);
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { engines?: { node?: string } }> };
    expect(lock.packages[''].engines?.node).toBe(`>=${NODE_MAJOR}.0.0`);
    expect(read('.nvmrc').trim()).toBe(String(NODE_MAJOR));
  });

  it('bundles every worker script for Node.js 24', () => {
    const bundled = Object.entries(manifest.scripts).filter(([, command]) => command.includes('esbuild '));
    expect(bundled.length).toBeGreaterThanOrEqual(6);
    for (const [name, command] of bundled) {
      expect(command, name).toContain(`--target=node${NODE_MAJOR}`);
      expect(command, name).not.toMatch(/--target=node(?!24)/);
    }
  });
});

describe('CI Node.js setup', () => {
  const workflowDir = path.join(ROOT, '.github', 'workflows');
  const actionDir = path.join(ROOT, '.github', 'actions');
  const files = [
    ...readdirSync(workflowDir).filter((name) => name.endsWith('.yml')).map((name) => path.join(workflowDir, name)),
    ...readdirSync(actionDir).map((name) => path.join(actionDir, name, 'action.yml')),
  ];

  /** Every `node-version` input of an actions/setup-node step in one parsed workflow or action. */
  function nodeVersions(node: unknown, found: string[] = []): string[] {
    if (Array.isArray(node)) {
      node.forEach((item) => nodeVersions(item, found));
    } else if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const withInputs = record.with as Record<string, unknown> | undefined;
      if (String(record.uses ?? '').startsWith('actions/setup-node@')) found.push(String(withInputs?.['node-version']));
      Object.values(record).forEach((value) => nodeVersions(value, found));
    }
    return found;
  }

  it('sets up Node.js 24 in every job that sets up Node.js', () => {
    const all = files.flatMap((file) => nodeVersions(parse(readFileSync(file, 'utf-8'))).map((version) => ({ file: path.basename(path.dirname(file)) + '/' + path.basename(file), version })));
    expect(all.length).toBeGreaterThanOrEqual(15);
    expect(all.filter((entry) => entry.version !== String(NODE_MAJOR))).toEqual([]);
  });
});
