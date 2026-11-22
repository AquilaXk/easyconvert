import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The worker and web packages of the container registry are private (docs/policy-decisions.md, entry 389), because the programs in them
 * are only run as a service and never handed out. Nothing may then read, inspect or tag an image anonymously, and no registry credential
 * may be kept: every consumer logs in with the token of its own run, with the right to read or write packages, before its first use.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf-8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string | boolean>;
}
interface Job {
  permissions?: Record<string, string>;
  steps?: Step[];
}

const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const workflows = fs.readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/.test(file)).sort();

/** A step that needs the registry: it pulls, inspects or tags an image, pushes one, or runs the script that pulls them. */
const USES_REGISTRY = /docker pull|imagetools (create|inspect)|docker push|ci-commit-gate\.sh|deploy\.sh (deploy|rollback)|type=registry/;
const isLogin = (step: Step) => step.uses?.startsWith('docker/login-action@') === true;

function jobsOf(file: string): Array<[string, Job]> {
  const parsed = parse(read(path.join('.github', 'workflows', file))) as { jobs: Record<string, Job> };
  return Object.entries(parsed.jobs);
}

function needsRegistry(step: Step): boolean {
  return isLogin(step) === false && (USES_REGISTRY.test(step.run ?? '') || USES_REGISTRY.test(Object.entries(step.with ?? {}).map(([key, value]) => `${key}: ${String(value)}`).join('\n')) || /build-push-action@/.test(step.uses ?? ''));
}

describe('the private worker and web packages', () => {
  const consumers = workflows.flatMap((file) => jobsOf(file).filter(([, job]) => (job.steps ?? []).some(needsRegistry)).map(([name, job]) => ({ where: `${file} ${name}`, job })));

  it('finds the jobs that use the registry: the image build, the promotion, the deploy gate, the deploy and the two jobs that read the layer cache or the image', () => {
    expect(consumers.map((consumer) => consumer.where)).toEqual(expect.arrayContaining([
      'ci.yml container',
      'deploy-oci.yml build',
      'deploy-oci.yml promote',
      'deploy-oci.yml gate',
      'deploy-oci.yml deploy',
      'nightly.yml bench-parity-office-image',
    ]));
  });

  for (const consumer of consumers) {
    it(`${consumer.where} logs in to ghcr.io with the token of the run before its first use of the registry, and asks for the packages scope`, () => {
      const steps = consumer.job.steps ?? [];
      const login = steps.findIndex(isLogin);
      const first = steps.findIndex(needsRegistry);
      expect(login, 'a login step').toBeGreaterThanOrEqual(0);
      expect(login).toBeLessThan(first);
      expect(steps[login].with).toMatchObject({ registry: 'ghcr.io', username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' });
      expect(['read', 'write']).toContain(consumer.job.permissions?.packages);
    });
  }

  it('keeps no registry credential: the only secret any workflow gives to a login is the workflow token', () => {
    for (const file of workflows) {
      for (const [name, job] of jobsOf(file)) {
        for (const step of (job.steps ?? []).filter(isLogin)) {
          expect(JSON.stringify(step.with), `${file} ${name}`).not.toMatch(/secrets\.(?!GITHUB_TOKEN\b)/);
          expect(step.with?.registry, `${file} ${name}`).toBe('ghcr.io');
        }
      }
    }
  });

  it('removes the login from the host of the deploy runner when the job ends', () => {
    const login = jobsOf('deploy-oci.yml').find(([name]) => name === 'deploy')?.[1].steps?.find(isLogin);
    expect(login?.with?.logout).toBe(true);
  });

  it('says in the docs that the images are private and run as a service, and no longer calls them public', () => {
    const deploy = read('docs/deploy-oci.md');
    expect(deploy).toMatch(/Container images \| GHCR, private packages/);
    expect(deploy).not.toMatch(/GHCR, public repository/);
    const licensing = read('docs/licensing.md');
    expect(licensing).toMatch(/images are private/i);
    expect(licensing).toMatch(/complete corresponding source/);
    expect(read('TODO.md')).not.toMatch(/Decide how the source and relinking terms of GNU MP/);
  });
});
