import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The packaging for the shared OCI host: the production compose file, the web image, the nginx site, the deploy workflow and
 * the deploy script. The expectations are written out here from the host rules of docs/policy-decisions.md (entry 122) and
 * the Docker, nginx and GitHub Actions references; none is read from the code that produced the files. The deploy script runs
 * for real against stand-ins for `docker`, `curl`, `df` and `mountpoint` that record their arguments.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf-8');

interface ComposeService {
  image?: string;
  container_name?: string;
  profiles?: string[];
  ports?: string[];
  networks?: string[];
  user?: string;
  read_only?: boolean;
  init?: boolean;
  pids_limit?: number;
  cpus?: string | number;
  cpu_shares?: number;
  mem_limit?: string;
  memswap_limit?: string;
  cap_drop?: string[];
  security_opt?: string[];
  command?: string[];
  tmpfs?: string[];
  volumes?: Array<string | { type: string; source: string; target: string; bind?: { create_host_path?: boolean } }>;
  logging?: { driver?: string; options?: Record<string, string> };
  deploy?: { replicas?: string };
  environment?: Record<string, string | null>;
  depends_on?: Record<string, { condition: string; required?: boolean }>;
  devices?: string[];
}
interface Compose {
  name: string;
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean }>;
}

const compose = parse(read('docker-compose.prod.yml'), { merge: true }) as Compose;
const APP_SERVICES = ['web', 'worker', 'worker-light', 'worker-cpu', 'worker-memory', 'worker-gpu'];
const LOOPBACK_PORT = /^127\.0\.0\.1:/;
/** `${NAME:-default}` as written in a limit; returns the default. */
const defaultOf = (value: string | number | undefined): string => {
  const match = /^\$\{[A-Z0-9_]+:-([^}]*)\}$/.exec(String(value));
  return match ? match[1] : String(value);
};
const MIB: Record<string, number> = { m: 1, g: 1024 };
const mebibytes = (value: string | undefined): number => {
  const match = /^(\d+)([mg])$/.exec(defaultOf(value));
  if (!match) throw new Error(`not a memory limit: ${value}`);
  return Number(match[1]) * MIB[match[2]];
};

describe('docker-compose.prod.yml network exposure', () => {
  it('publishes only the web service, on the loopback address, on a port the other service does not use', () => {
    const published = Object.entries(compose.services).flatMap(([name, service]) => (service.ports ?? []).map((port) => ({ name, port })));
    expect(published.map(({ name }) => name)).toEqual(['web']);
    for (const { port } of published) expect(port).toMatch(LOOPBACK_PORT);
    const hostPort = Number(/^127\.0\.0\.1:\$\{EASYCONVERT_WEB_PORT:-(\d+)\}:3000$/.exec(published[0].port)?.[1]);
    const TAKEN_BY_THE_OTHER_SERVICE = [15432, 9000, 9001, 8080, 8082, 9090, 9093, 3100, 3000, 32080];
    expect(hostPort).toBe(8090);
    expect(TAKEN_BY_THE_OTHER_SERVICE).not.toContain(hostPort);
  });

  it('keeps Redis off every published port and on the internal network only', () => {
    const redis = compose.services.redis;
    expect(redis.ports).toBeUndefined();
    expect(redis.networks).toEqual(['backend']);
    expect(compose.networks.backend.internal).toBe(true);
    for (const name of ['web', 'worker']) expect(compose.services[name].networks).toEqual(['backend', 'egress']);
  });

  it('runs Redis with a password, a memory ceiling that refuses writes instead of evicting, and a small append-only file', () => {
    const redis = compose.services.redis;
    const command = (redis.command ?? []).join(' ');
    expect(command).toContain('--requirepass "$$REDIS_PASSWORD"');
    expect(command).toContain('test -n "$$REDIS_PASSWORD"');
    expect(command).toContain('--maxmemory 256mb');
    expect(command).toContain('--maxmemory-policy noeviction');
    expect(command).toContain('--appendonly yes');
    expect(command).toContain('--auto-aof-rewrite-min-size 16mb');
    expect(command).toContain('--protected-mode yes');
    expect(redis.image).toMatch(/^redis:[0-9.]+-alpine@sha256:[0-9a-f]{64}$/);
    expect(redis.profiles).toEqual(['redis']);
  });

  it('is named so that it cannot touch the containers of another project', () => {
    expect(compose.name).toBe('easyconvert');
    for (const [name, service] of Object.entries(compose.services)) {
      if (service.container_name) expect(service.container_name, name).toMatch(/^easyconvert-/);
    }
  });
});

describe('docker-compose.prod.yml container hardening', () => {
  it.each(APP_SERVICES)('%s drops all capabilities, forbids new privileges, applies the worker seccomp profile and has a read-only root', (name) => {
    const service = compose.services[name];
    expect(service.cap_drop).toEqual(['ALL']);
    expect(service.security_opt).toEqual(['no-new-privileges:true', 'seccomp=./docker/seccomp-worker.json']);
    expect(service.read_only).toBe(true);
    expect(service.init).toBe(true);
    expect(service.pids_limit).toBe(256);
  });

  it('hardens Redis the same way, as a non-root user', () => {
    const redis = compose.services.redis;
    expect(redis.cap_drop).toEqual(['ALL']);
    expect(redis.security_opt).toEqual(['no-new-privileges:true']);
    expect(redis.read_only).toBe(true);
    expect(redis.user).toMatch(/^[1-9]\d*:\d+$/);
  });

  it.each(['redis', ...APP_SERVICES])('%s rotates its json-file log at 5 MB and keeps 3 files', (name) => {
    expect(compose.services[name].logging).toEqual({ driver: 'json-file', options: { 'max-size': '5m', 'max-file': '3' } });
  });

  it('mounts every tmpfs without exec rights on the paths that hold uploads, and with the image user as owner', () => {
    for (const name of APP_SERVICES) {
      for (const mount of compose.services[name].tmpfs ?? []) {
        const options = new Set(mount.slice(mount.indexOf(':') + 1).split(','));
        expect(options.has('nosuid'), `${name} ${mount}`).toBe(true);
        expect(options.has('nodev'), `${name} ${mount}`).toBe(true);
        expect(options.has('uid=10001'), `${name} ${mount}`).toBe(true);
      }
    }
  });

  it('puts uploads, results and /tmp on the capped scratch directory, never on RAM, and never creates the host path', () => {
    for (const name of ['web', 'worker']) {
      const service = compose.services[name];
      const binds = (service.volumes ?? []).filter((volume): volume is Extract<typeof volume, object> => typeof volume === 'object');
      const targets = binds.map((volume) => volume.target).sort();
      expect(targets, name).toEqual(['/shared/storage', '/tmp']);
      for (const bind of binds) {
        expect(bind.source, name).toMatch(/^\$\{EASYCONVERT_SCRATCH_DIR(:\?[^}]+)?\}\//);
        expect(bind.bind?.create_host_path, name).toBe(false);
      }
      expect((service.tmpfs ?? []).some((mount) => mount.startsWith('/tmp:')), name).toBe(false);
    }
  });
});

describe('docker-compose.prod.yml resource budget', () => {
  it.each(['redis', ...APP_SERVICES])('%s has a hard cpu limit, a hard memory limit with the same swap limit, and a cpu weight below the default', (name) => {
    const service = compose.services[name];
    expect(Number(defaultOf(service.cpus))).toBeGreaterThan(0);
    expect(mebibytes(service.mem_limit)).toBeGreaterThan(0);
    expect(service.memswap_limit).toBe(service.mem_limit);
    expect(service.cpu_shares).toBeLessThan(1024);
    expect(service.cpu_shares).toBeGreaterThan(0);
  });

  it('adds up to 3.5 cpus and 20 GiB for the services that run at launch', () => {
    const launch = ['redis', 'web', 'worker'];
    const cpus = launch.reduce((sum, name) => sum + Number(defaultOf(compose.services[name].cpus)), 0);
    const memory = launch.reduce((sum, name) => sum + mebibytes(compose.services[name].mem_limit), 0);
    expect(Math.round(cpus * 10) / 10).toBe(3.5);
    expect(memory).toBeLessThanOrEqual(20 * 1024);
    expect(memory).toBeGreaterThan(19 * 1024);
  });

  it('gives each worker job at least the 3.3 GiB share the input limits are sized for', () => {
    const worker = compose.services.worker;
    const jobs = Number(defaultOf(worker.environment?.WORKER_CONCURRENCY ?? undefined));
    expect(mebibytes(worker.mem_limit) / jobs).toBeGreaterThanOrEqual(3.3 * 1024);
  });

  it('starts only redis, web and worker by default; the classes and the GPU worker need a profile', () => {
    const always = Object.entries(compose.services).filter(([, service]) => !service.profiles).map(([name]) => name);
    expect(always.sort()).toEqual(['web', 'worker']);
    expect(compose.services.redis.profiles).toEqual(['redis']);
  });
});

describe('docker-compose.prod.yml scale-out shape', () => {
  const QUEUES: Record<string, string> = { 'worker-light': 'light', 'worker-cpu': 'cpu', 'worker-memory': 'memory', 'worker-gpu': 'gpu' };

  it('has one worker per resource class on its own queue, each with its own replica count and limits', () => {
    for (const [name, queue] of Object.entries(QUEUES)) {
      const service = compose.services[name];
      expect(service.environment?.WORKER_QUEUES, name).toBe(queue);
      expect(service.deploy?.replicas, name).toMatch(/^\$\{EASYCONVERT_CLASS_[A-Z]+_REPLICAS:-1\}$/);
      expect(String(service.cpus), name).toMatch(/^\$\{EASYCONVERT_CLASS_[A-Z]+_CPUS:-/);
      expect(service.container_name, name).toBeUndefined();
    }
    expect(compose.services.worker.deploy?.replicas).toBe('${EASYCONVERT_WORKER_REPLICAS:-1}');
    expect(compose.services.worker.container_name).toBeUndefined();
    expect(compose.services['worker-gpu'].devices).toEqual(['/dev/dri:/dev/dri']);
  });

  it('couples web and workers only through Redis and the storage driver root', () => {
    for (const name of ['web', 'worker']) {
      const env = compose.services[name].environment ?? {};
      expect(env.REDIS_URL, name).toMatch(/^\$\{REDIS_URL:-redis:\/\//);
      expect(env.STORAGE_DRIVER, name).toBe('${STORAGE_DRIVER:-local}');
      expect(env.EASYCONVERT_STORAGE_DIR, name).toBe('/shared/storage');
      expect(compose.services[name].depends_on?.redis.required, name).toBe(false);
    }
    expect(compose.services.web.depends_on && Object.keys(compose.services.web.depends_on)).toEqual(['redis']);
  });

  it('gives every worker its own heartbeat file so that replicas do not share one', () => {
    for (const name of ['worker', 'worker-light', 'worker-cpu', 'worker-memory', 'worker-gpu']) {
      expect(compose.services[name].environment?.WORKER_HEARTBEAT_FILE, name).toBe('/home/easyconvert/worker-heartbeat.json');
    }
  });
});

describe('Dockerfile.web', () => {
  const web = read('Dockerfile.web');
  const worker = read('Dockerfile.worker');
  const nodeImage = (text: string): string | undefined => /^ARG NODE_IMAGE=(\S+)$/m.exec(text)?.[1];

  it('uses the Node.js base of the worker image, pinned by tag and digest', () => {
    expect(nodeImage(web)).toBeDefined();
    expect(nodeImage(web)).toBe(nodeImage(worker));
    expect(nodeImage(web)).toMatch(/^node:\d+\.\d+\.\d+-[a-z]+-slim@sha256:[0-9a-f]{64}$/);
  });

  it('is built on the worker image, runs as its non-root user and starts Next.js', () => {
    expect(web).toMatch(/^FROM \$\{WORKER_IMAGE\} AS web$/m);
    expect(web).not.toMatch(/^USER root/m);
    expect(web).toMatch(/--chown=easyconvert:easyconvert/);
    expect(web).toMatch(/^CMD \["node", "node_modules\/next\/dist\/bin\/next", "start"/m);
    expect(web).toContain('/api/health');
  });
});

describe('nginx site file', () => {
  const site = read('deploy/oci/nginx-easyconvert.conf');
  const withoutComments = site.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

  it('adds one server for one name, with no default server and no listener on port 80', () => {
    expect(withoutComments).not.toMatch(/default_server/);
    expect(withoutComments).not.toMatch(/listen\s+(\[::\]:)?80\b/);
    expect(withoutComments.match(/^server \{/gm)).toHaveLength(1);
    expect(withoutComments).toMatch(/server_name easyconvert\.aquilaxk\.site;/);
  });

  it('names every http-level object with the easyconvert_ prefix, so that it cannot collide with the other site', () => {
    const names = [...withoutComments.matchAll(/^(?:limit_req_zone .*zone=|limit_conn_zone .*zone=|log_format |upstream |map \$\w+ \$)(\w+)/gm)].map((match) => match[1]);
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) expect(name).toMatch(/^easyconvert_/);
  });

  it('accepts the largest body the application accepts and no more than the free plan of the CDN', () => {
    const route = read('src/app/api/convert/route.ts');
    const cap = /const MAX_FILE_SIZE = (\d+) \* 1024 \* 1024/.exec(route);
    expect(cap).not.toBeNull();
    const nginxMegabytes = Number(/client_max_body_size (\d+)m;/.exec(withoutComments)?.[1]);
    expect(nginxMegabytes).toBeGreaterThan(Number(cap?.[1]));
    expect(nginxMegabytes).toBeLessThanOrEqual(Number(cap?.[1]) + 8);
  });

  it('trusts CF-Connecting-IP only from the CDN ranges and hands the application exactly one forwarded address', () => {
    expect(withoutComments).toMatch(/real_ip_header CF-Connecting-IP;/);
    expect(withoutComments).toMatch(/real_ip_recursive on;/);
    expect(withoutComments.match(/set_real_ip_from /g)?.length).toBeGreaterThanOrEqual(22);
    expect(withoutComments).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(withoutComments).not.toMatch(/\$proxy_add_x_forwarded_for/);
    expect(withoutComments).toMatch(/proxy_set_header Forwarded "";/);
  });

  it('proxies only to the loopback port of the web service and streams bodies without spooling to disk', () => {
    const upstreams = [...withoutComments.matchAll(/server (\S+);/g)].map((match) => match[1]);
    expect(upstreams.filter((target) => !/^127\.0\.0\.1:8090$|^easyconvert\.aquilaxk\.site$/.test(target))).toEqual([]);
    expect(withoutComments).toMatch(/proxy_request_buffering off;/);
    expect(withoutComments).toMatch(/proxy_buffering off;/);
  });

  it('limits request rates, waits longer than a synchronous conversion may take and writes a JSON edge log', () => {
    expect(withoutComments).toMatch(/limit_req zone=easyconvert_convert/);
    expect(withoutComments).toMatch(/limit_conn easyconvert_conn/);
    const readTimeout = Number(/proxy_read_timeout (\d+)s;/.exec(withoutComments)?.[1]);
    const syncDeadlineSeconds = 120;
    expect(readTimeout).toBeGreaterThan(syncDeadlineSeconds);
    expect(withoutComments).toMatch(/log_format easyconvert_edge_json escape=json/);
    expect(withoutComments).toMatch(/access_log \/var\/log\/nginx\/easyconvert-edge\.log easyconvert_edge_json/);
  });

  it('takes its certificate from files the operator installs, not from port 80 or a stored API token', () => {
    expect(withoutComments).toMatch(/ssl_certificate \/etc\/ssl\/easyconvert\/origin\.pem;/);
    expect(withoutComments).toMatch(/ssl_certificate_key \/etc\/ssl\/easyconvert\/origin\.key;/);
    expect(withoutComments).not.toMatch(/letsencrypt/);
  });
});

describe('deploy workflow', () => {
  const text = read('.github/workflows/deploy-oci.yml');
  const workflow = parse(text) as {
    on: { push: { branches: string[] }; workflow_dispatch: { inputs: Record<string, unknown> } };
    permissions: Record<string, string>;
    jobs: Record<string, { 'runs-on': unknown; environment?: string; if?: string; permissions?: Record<string, string>; 'timeout-minutes'?: number; steps: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string>; if?: string }> }>;
  };

  it('pins every action to a full commit hash with its version in a comment', () => {
    const uses = text.split('\n').filter((line) => /^\s+uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line.trim()).toMatch(/^uses:\s*\S+@[0-9a-f]{40}\s+#\s*v\d+(\.\d+)*\s*$/);
  });

  it('builds on main for arm64 only, and puts the web image on the digest of the worker image it just built', () => {
    expect(workflow.on.push.branches).toEqual(['main']);
    const build = workflow.jobs.build;
    expect(build['runs-on']).toBe('ubuntu-24.04-arm');
    expect(build.if).toBe("github.event_name == 'push'");
    const buildSteps = build.steps.filter((step) => step.uses?.startsWith('docker/build-push-action@'));
    expect(buildSteps).toHaveLength(2);
    for (const step of buildSteps) expect(step.with?.platforms).toBe('linux/arm64');
    expect(buildSteps[1].with?.['build-args']).toContain('@${{ steps.worker.outputs.digest }}');
    expect(build.permissions).toEqual({ contents: 'read', packages: 'write' });
  });

  it('deploys by hand, from main, on a runner and in an environment of its own that the other service does not use', () => {
    const deploy = workflow.jobs.deploy;
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(deploy.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(deploy.if).toContain("github.ref == 'refs/heads/main'");
    expect(deploy['runs-on']).toEqual(['self-hosted', 'Linux', 'ARM64', 'easyconvert-production']);
    expect(deploy.environment).toBe('easyconvert-production');
    expect(deploy.permissions).toEqual({ contents: 'read', packages: 'read' });
    expect(text).not.toMatch(/easysubway/i);
  });

  it('reads the env secret into one step through the allowlist, and writes nothing about it to the log', () => {
    const steps = workflow.jobs.deploy.steps;
    const holders = steps.filter((step) => JSON.stringify(step).includes('secrets.EASYCONVERT_ENV'));
    expect(holders).toHaveLength(1);
    expect(holders[0].env).toEqual({ EASYCONVERT_ENV: '${{ secrets.EASYCONVERT_ENV }}' });
    expect(holders[0].run).toContain('deploy.sh filter-env');
    expect(holders[0].run).toContain('umask 077');
    expect(holders[0].run).not.toMatch(/\becho\b[^\n]*\$EASYCONVERT_ENV/);
    expect(text.match(/secrets\.[A-Z_]+/g)?.sort()).toEqual(['secrets.EASYCONVERT_ENV', 'secrets.GITHUB_TOKEN', 'secrets.GITHUB_TOKEN']);
    expect(steps.at(-1)?.run).toContain('rm -f');
  });

  it('runs no shell on the host except the deploy script, and no ssh', () => {
    const runs = workflow.jobs.deploy.steps.map((step) => step.run ?? '').join('\n');
    expect(runs).not.toMatch(/\bssh\b|\bscp\b|\bsudo\b|docker system prune|docker image prune|docker volume prune/);
    expect(runs).toContain('deploy.sh deploy "$IMAGE_REF"');
    expect(runs).toContain('deploy.sh rollback');
  });
});

describe('env allowlist', () => {
  const allowlist = read('deploy/oci/env-allowlist.txt').split('\n').filter(Boolean);
  const composeText = read('docker-compose.prod.yml');
  const referenced = new Set([...composeText.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:}?-]/g)].map((match) => match[1]));
  const passedThrough = Object.values(compose.services).flatMap((service) =>
    Object.entries(service.environment ?? {}).filter(([, value]) => value === null).map(([name]) => name)
  );
  const SET_BY_THE_DEPLOY_JOB = ['EASYCONVERT_WEB_IMAGE', 'EASYCONVERT_WORKER_IMAGE'];

  it('is sorted and has no duplicate', () => {
    expect(allowlist).toEqual([...new Set(allowlist)].sort());
  });

  it('lets through every variable the compose file reads and every variable it passes through', () => {
    const wanted = [...new Set([...referenced, ...passedThrough])].filter((name) => !SET_BY_THE_DEPLOY_JOB.includes(name));
    const unlisted = wanted.filter((name) => !allowlist.includes(name));
    expect(unlisted).toEqual([]);
  });

  it('lets through the two budget knobs and keeps the digest-pinned image variables out of reach of the secret', () => {
    expect(allowlist).toContain('EASYCONVERT_BUDGET_CPUS');
    expect(allowlist).toContain('EASYCONVERT_BUDGET_MEMORY_GB');
    for (const name of SET_BY_THE_DEPLOY_JOB) expect(allowlist).not.toContain(name);
  });

  it('lists nothing that the compose file does not read', () => {
    const known = new Set([...referenced, ...passedThrough, 'EASYCONVERT_BUDGET_CPUS', 'EASYCONVERT_BUDGET_MEMORY_GB']);
    expect(allowlist.filter((name) => !known.has(name))).toEqual([]);
  });
});

const SCRIPT = path.join(ROOT, 'deploy', 'oci', 'deploy.sh');
const ENV_BODY = ['EASYCONVERT_SCRATCH_DIR=/scratch', 'APP_URL=https://convert.example.test', 'REDIS_PASSWORD=redis-password-value'].join('\n');

function run(args: string[], options: { env?: Record<string, string>; input?: string; cwd?: string } = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    input: options.input,
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...options.env } as unknown as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('deploy.sh filter-env', () => {
  it('keeps the allowlisted keys, drops the others and names only the key of a dropped line', () => {
    const input = ['# a comment', '', 'JWT_SECRET=a=b=c', 'EASYCONVERT_WEB_IMAGE=evil@sha256:0', 'UNLISTED_KEY=top-secret-value', 'no-equals-sign', 'APP_URL=https://x.test\r'].join('\n');
    const result = run(['filter-env'], { input });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('JWT_SECRET=a=b=c\nAPP_URL=https://x.test\n');
    expect(result.stderr).toContain("key 'UNLISTED_KEY'");
    expect(result.stderr).toContain("key 'EASYCONVERT_WEB_IMAGE'");
    expect(result.stderr).not.toContain('top-secret-value');
    expect(result.stderr).not.toContain('a=b=c');
  });
});

describe('deploy.sh budget', () => {
  const values = (stdout: string): Record<string, string> => Object.fromEntries(stdout.trim().split('\n').map((line) => line.split('=') as [string, string]));

  it('derives the limits that the compose file defaults to from the launch budget of 3.5 cpus and 20 GiB', () => {
    const result = run(['budget']);
    expect(result.status).toBe(0);
    const derived = values(result.stdout);
    expect(Number(derived.EASYCONVERT_WORKER_CPUS)).toBe(Number(defaultOf(compose.services.worker.cpus)));
    expect(Number(derived.EASYCONVERT_WEB_CPUS)).toBe(Number(defaultOf(compose.services.web.cpus)));
    expect(Number(derived.EASYCONVERT_REDIS_CPUS)).toBe(Number(defaultOf(compose.services.redis.cpus)));
    expect(mebibytes(derived.EASYCONVERT_WORKER_MEMORY)).toBe(mebibytes(compose.services.worker.mem_limit));
    expect(mebibytes(derived.EASYCONVERT_WEB_MEMORY)).toBe(mebibytes(compose.services.web.mem_limit));
    expect(derived.EASYCONVERT_WORKER_CONCURRENCY).toBe(defaultOf(compose.services.worker.environment?.WORKER_CONCURRENCY ?? undefined));
  });

  it('never allots more than the budget and gives each job at least 3.3 GiB, whatever the size', () => {
    for (const [cpus, gib] of [[1.5, 6], [2, 8], [3.5, 20], [4, 24], [8, 48], [16, 96]]) {
      const result = run(['budget'], { env: { EASYCONVERT_BUDGET_CPUS: String(cpus), EASYCONVERT_BUDGET_MEMORY_GB: String(gib) } });
      expect(result.status, `${cpus} cpus ${gib} GiB`).toBe(0);
      const derived = values(result.stdout);
      const totalCpus = ['REDIS', 'WEB', 'WORKER'].reduce((sum, key) => sum + Number(derived[`EASYCONVERT_${key}_CPUS`]), 0);
      const totalMib = mebibytes(derived.EASYCONVERT_WEB_MEMORY) + mebibytes(derived.EASYCONVERT_WORKER_MEMORY) + 512;
      expect(totalCpus, `${cpus} cpus`).toBeLessThanOrEqual(cpus + 0.05);
      expect(totalMib, `${gib} GiB`).toBeLessThanOrEqual(gib * 1024);
      const jobs = Number(derived.EASYCONVERT_WORKER_CONCURRENCY);
      expect(jobs).toBeGreaterThanOrEqual(1);
      if (jobs > 1) expect(mebibytes(derived.EASYCONVERT_WORKER_MEMORY) / jobs).toBeGreaterThanOrEqual(3.3 * 1024);
    }
  });

  it('refuses a budget too small to run a conversion and a value that is not a number', () => {
    expect(run(['budget'], { env: { EASYCONVERT_BUDGET_CPUS: '1', EASYCONVERT_BUDGET_MEMORY_GB: '4' } }).status).not.toBe(0);
    expect(run(['budget'], { env: { EASYCONVERT_BUDGET_CPUS: '3.5; rm -rf /', EASYCONVERT_BUDGET_MEMORY_GB: '20' } }).status).not.toBe(0);
  });
});

describe('deploy.sh against stand-ins for the host', () => {
  const sandboxes: string[] = [];
  let sandbox: string;
  let home: string;
  let bin: string;
  let log: string;
  let envFile: string;

  const stub = (name: string, body: string): void => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  };

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'oci-deploy-'));
    sandboxes.push(sandbox);
    home = path.join(sandbox, 'home');
    bin = path.join(sandbox, 'bin');
    log = path.join(sandbox, 'calls.log');
    envFile = path.join(sandbox, 'filtered.env');
    mkdirSync(bin);
    mkdirSync(home);
    writeFileSync(log, '');
    writeFileSync(envFile, `${ENV_BODY}\n`);
    stub(
      'docker',
      `echo "docker $*" >> "$STUB_LOG"
case "$1" in
  pull) exit 0 ;;
  image)
    case "$2" in
      inspect) ref="\${@: -1}"; echo "\${ref%%:*}@sha256:$(printf '%s' "$ref" | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-64)" ;;
      ls) cat "$STUB_IMAGES" 2>/dev/null || true ;;
      rm) exit 0 ;;
    esac ;;
  compose)
    dir=""; prev=""
    for arg in "$@"; do [ "$prev" = "--project-directory" ] && dir="$arg"; prev="$arg"; done
    case " $* " in
      *" up "*) case "$dir" in *"$STUB_FAIL_UP"*) [ -n "$STUB_FAIL_UP" ] && exit 1 ;; esac ;;
    esac ;;
esac
exit 0`
    );
    stub(
      'curl',
      `echo "curl $*" >> "$STUB_LOG"
last_up="$(grep ' up ' "$STUB_LOG" | tail -n 1)"
case "$last_up" in *"$STUB_FAIL_HEALTH"*) [ -n "$STUB_FAIL_HEALTH" ] && exit 22 ;; esac
exit 0`
    );
    stub('mountpoint', 'exit "${STUB_MOUNT_STATUS:-0}"');
    stub('df', `case "$*" in *avail*) printf 'Avail\\n%s\\n' "\${STUB_AVAIL_GIB:-100}" ;; *) printf 'Use%%\\n %s%%\\n' "\${STUB_USED:-10}" ;; esac`);
    stub('logger', 'echo "logger $*" >> "$STUB_LOG"');
  });

  afterAll(() => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  });

  const hostEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    EASYCONVERT_HOME: home,
    STUB_LOG: log,
    STUB_IMAGES: path.join(sandbox, 'images.txt'),
    HEALTH_ATTEMPTS: '2',
    HEALTH_INTERVAL: '0',
    SOURCE_DIR: ROOT,
    ENV_FILE: envFile,
    ...extra,
  });
  const calls = (): string[] => readFileSync(log, 'utf-8').split('\n').filter(Boolean);
  const releases = (): string[] => (existsSync(path.join(home, 'releases')) ? readdirSync(path.join(home, 'releases')) : []);
  const currentRelease = (): string => path.basename(readlinkSync(path.join(home, 'current')));

  it('refuses to run when the scratch directory is not a mount point', () => {
    const result = run(['deploy', 'main'], { env: hostEnv({ STUB_MOUNT_STATUS: '1' }) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not a mount point');
    expect(calls().filter((call) => call.startsWith('docker pull'))).toEqual([]);
  });

  it('refuses to pull when the data volume has less free space than the minimum', () => {
    const result = run(['deploy', 'main'], { env: hostEnv({ STUB_AVAIL_GIB: '14' }) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('only 14 GiB free');
    expect(calls().filter((call) => call.startsWith('docker pull'))).toEqual([]);
  });

  it('warns through the system log when the scratch file system is nearly full', () => {
    const result = run(['guard', envFile], { env: hostEnv({ STUB_USED: '91' }) });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('scratch is 91% full');
    expect(calls().some((call) => call.startsWith('logger -t easyconvert'))).toBe(true);
  });

  it('pins both images by digest, writes a private env file with the derived budget, starts the stack and records the release', () => {
    const result = run(['deploy', 'sha-0123456789abcdef'], { env: hostEnv() });
    expect(result.status, result.stderr).toBe(0);
    const release = path.join(home, 'releases', currentRelease());
    const images = readFileSync(path.join(release, 'images.env'), 'utf-8');
    expect(images).toMatch(/^EASYCONVERT_WORKER_IMAGE=ghcr\.io\/aquilaxk\/easyconvert-worker@sha256:[0-9a-f]{64}$/m);
    expect(images).toMatch(/^EASYCONVERT_WEB_IMAGE=ghcr\.io\/aquilaxk\/easyconvert-web@sha256:[0-9a-f]{64}$/m);
    const env = readFileSync(path.join(release, '.env'), 'utf-8');
    expect(env).toContain('REDIS_PASSWORD=redis-password-value');
    expect(env).toContain('EASYCONVERT_WORKER_CONCURRENCY=4');
    expect(env).toContain('EASYCONVERT_WORKER_IMAGE=');
    expect(statSync(path.join(release, '.env')).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(release, 'docker-compose.prod.yml'))).toBe(true);
    expect(existsSync(path.join(release, 'docker', 'seccomp-worker.json'))).toBe(true);
    expect(calls().some((call) => / up -d --wait .*--remove-orphans/.test(call))).toBe(true);
    expect(calls().some((call) => call.includes('--profile redis'))).toBe(true);
    expect(calls().some((call) => call.startsWith('curl') && call.includes('http://127.0.0.1:8090/api/health'))).toBe(true);
    expect(result.stderr).not.toContain('redis-password-value');
  });

  it('lets a setting in the env file win over the value derived from the budget, and uses an external Redis without starting this one', () => {
    writeFileSync(envFile, `${ENV_BODY}\nEASYCONVERT_WORKER_CONCURRENCY=2\nREDIS_URL=rediss://:x@redis.example.test:6380\n`);
    const result = run(['deploy', 'main'], { env: hostEnv() });
    expect(result.status, result.stderr).toBe(0);
    const env = readFileSync(path.join(home, 'releases', currentRelease(), '.env'), 'utf-8');
    expect(env.match(/^EASYCONVERT_WORKER_CONCURRENCY=.*$/gm)).toEqual(['EASYCONVERT_WORKER_CONCURRENCY=2']);
    expect(calls().some((call) => call.includes('--profile redis'))).toBe(false);
  });

  it('rolls back to the previous release when the new one does not start, and removes the failed release', () => {
    expect(run(['deploy', 'good'], { env: hostEnv() }).status).toBe(0);
    const good = currentRelease();
    const result = run(['deploy', 'bad'], { env: hostEnv({ STUB_FAIL_UP: '-bad' }) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rolling back');
    expect(currentRelease()).toBe(good);
    expect(releases()).toEqual([good]);
    const ups = calls().filter((call) => / up -d /.test(call));
    expect(ups.at(-1)).toContain(good);
  });

  it('rolls back when the stack starts but the health check never passes', () => {
    expect(run(['deploy', 'good'], { env: hostEnv() }).status).toBe(0);
    const good = currentRelease();
    const result = run(['deploy', 'sick'], { env: hostEnv({ STUB_FAIL_HEALTH: '-sick' }) });
    expect(result.status).toBe(1);
    expect(currentRelease()).toBe(good);
    expect(calls().filter((call) => / up -d /.test(call)).at(-1)).toContain(good);
  });

  it('stops the stack when the first release is unhealthy and there is nothing to roll back to', () => {
    const result = run(['deploy', 'sick'], { env: hostEnv({ STUB_FAIL_HEALTH: '-sick' }) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no previous release');
    expect(existsSync(path.join(home, 'current'))).toBe(false);
    expect(calls().some((call) => / down$/.test(call))).toBe(true);
  });

  it('keeps the current and the previous release and their images, and removes only unused images of its own repositories', () => {
    for (const ref of ['one', 'two', 'three']) expect(run(['deploy', ref], { env: hostEnv() }).status).toBe(0);
    expect(releases()).toHaveLength(2);
    expect(lstatSync(path.join(home, 'previous')).isSymbolicLink()).toBe(true);
    const digestsOf = (link: string): string[] => (readFileSync(path.join(home, link, 'images.env'), 'utf-8').match(/sha256:[0-9a-f]{64}/g) ?? []);
    const [becomesPrevious] = digestsOf('current');
    const [becomesUnused] = digestsOf('previous');
    const stale = `sha256:${'a'.repeat(64)}`;
    const elsewhere = `sha256:${'b'.repeat(64)}`;
    writeFileSync(
      path.join(sandbox, 'images.txt'),
      [
        `ghcr.io/aquilaxk/easyconvert-worker ${becomesPrevious} keepprevious`,
        `ghcr.io/aquilaxk/easyconvert-worker ${becomesUnused} removeunused`,
        `ghcr.io/aquilaxk/easyconvert-worker ${stale} removestale`,
        `ghcr.io/example/other-service ${elsewhere} neverthis`,
      ].join('\n')
    );
    writeFileSync(log, '');
    expect(run(['deploy', 'four'], { env: hostEnv() }).status).toBe(0);
    const removed = calls().filter((call) => call.startsWith('docker image rm')).join('\n');
    expect(removed).toContain('removeunused');
    expect(removed).toContain('removestale');
    expect(removed).not.toContain('neverthis');
    expect(removed).not.toContain('keepprevious');
    expect(calls().filter((call) => /prune/.test(call))).toEqual([]);
  });

  it('rolls back on request to the previous release and swaps the two links', () => {
    expect(run(['deploy', 'one'], { env: hostEnv() }).status).toBe(0);
    const first = currentRelease();
    expect(run(['deploy', 'two'], { env: hostEnv() }).status).toBe(0);
    const second = currentRelease();
    const result = run(['rollback'], { env: hostEnv() });
    expect(result.status, result.stderr).toBe(0);
    expect(currentRelease()).toBe(first);
    expect(path.basename(readlinkSync(path.join(home, 'previous')))).toBe(second);
  });

  it('refuses to roll back when there is no previous release', () => {
    expect(run(['rollback'], { env: hostEnv() }).status).not.toBe(0);
  });

  it('never leaves the home directory it was given', () => {
    run(['deploy', 'one'], { env: hostEnv() });
    expect(readdirSync(sandbox).sort()).toEqual(['bin', 'calls.log', 'filtered.env', 'home']);
  });
});

describe('operations document and policy entry', () => {
  const doc = read('docs/deploy-oci.md');
  const policy = read('docs/policy-decisions.md');

  it('has the sections QA needs, and links the issues it updates', () => {
    for (const heading of ['## First-time setup', '## Capacity budget', '## Delete on delivery', '## Rolling back', '## Scaling later', '## Cost']) {
      expect(doc).toContain(heading);
    }
    for (const issue of ['#900', '#564', '#691', '#665']) expect(doc).toContain(issue);
  });

  it('writes no secret value and no key material', () => {
    expect(doc).not.toMatch(/-----BEGIN/);
    expect(doc).not.toMatch(/(?:SECRET|PASSWORD|KEK|PEPPER)=[A-Za-z0-9+/]{12,}/);
  });

  it('names each file that the document tells the operator to install', () => {
    for (const file of ['deploy/oci/nginx-easyconvert.conf', 'deploy/oci/logrotate-easyconvert.conf', 'deploy/oci/deploy.sh', 'deploy/oci/env-allowlist.txt']) {
      expect(doc).toContain(file);
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });

  it('records the hosting and storage decision as entry 122', () => {
    expect(policy).toMatch(/^## 122\. /m);
    expect(policy).toMatch(/^122\. \[/m);
  });
});
