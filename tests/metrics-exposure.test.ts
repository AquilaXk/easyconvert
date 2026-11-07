import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { defaultMetricsPort } from '../src/lib/metrics/server';

/**
 * The metrics are for the operator, not the public (docs/slo.md). Their listener is a port of its own in each container, so this
 * holds the three places that could make it public: the nginx site, the published ports of the compose file, and the routes of the
 * web application. The expectations are written out here, not read from the code that sets them.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf-8');
const uncommented = (text: string): string => text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

const METRICS_PORTS = [defaultMetricsPort('web'), defaultMetricsPort('worker')].map(String);

interface ComposeService {
  ports?: string[];
  environment?: Record<string, string | null>;
}
const compose = parse(read('docker-compose.prod.yml'), { merge: true }) as { services: Record<string, ComposeService>; 'x-app-environment': Record<string, string> };

describe('the nginx site', () => {
  const site = uncommented(read('deploy/oci/nginx-easyconvert.conf'));
  const blocks = [...site.matchAll(/^\s*location ([^{]+)\{([^}]*)\}/gm)].map((match) => ({ match: match[1].trim(), body: match[2] }));

  it('refuses /metrics and /api/metrics, whatever follows them', () => {
    for (const prefix of ['^~ /metrics', '^~ /api/metrics']) {
      expect(blocks.find((block) => block.match === prefix)?.body.trim(), prefix).toBe('return 404;');
    }
  });

  it('forwards only to the one upstream, which is the loopback port of the web service and not a metrics port', () => {
    const upstream = /upstream easyconvert_web \{\s*server ([^;]+);/.exec(site)?.[1];
    expect(upstream).toBe('127.0.0.1:8090');
    const targets = [...site.matchAll(/proxy_pass\s+([^;]+);/g)].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toBe('http://easyconvert_web');
  });

  it('names no metrics port anywhere', () => {
    for (const port of METRICS_PORTS) expect(site).not.toContain(port);
  });
});

describe('the production compose file', () => {
  it('publishes no metrics port, and no port at all that is not bound to the loopback address', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      for (const published of service.ports ?? []) {
        expect(published, `${name} publishes ${published}`).toMatch(/^127\.0\.0\.1:/);
        for (const port of METRICS_PORTS) expect(published, name).not.toContain(port);
      }
    }
    expect(compose.services.web.ports).toHaveLength(1);
    for (const name of Object.keys(compose.services).filter((service) => service.startsWith('worker'))) expect(compose.services[name].ports).toBeUndefined();
  });

  it('opens the listener on every address of the container, so that a scraper on the stack networks reaches it', () => {
    expect(compose['x-app-environment'].METRICS_HOST).toBe('0.0.0.0');
    expect(compose['x-app-environment'].METRICS_PORT).toBeUndefined();
  });
});

describe('the web application', () => {
  it('has no route at the metrics paths, so that nothing behind the proxy could answer them', () => {
    for (const dir of ['src/app/metrics', 'src/app/api/metrics', 'src/app/[locale]/metrics', 'src/app/api/v1/metrics']) {
      expect(existsSync(path.join(ROOT, dir)), dir).toBe(false);
    }
  });
});
