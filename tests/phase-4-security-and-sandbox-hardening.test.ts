import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { execForm, parseDockerfile } from './helpers/dockerfile';
import {
  yieldToEventLoop,
  measureEventLoopLag,
  forEachCooperative,
  EventLoopMonitor,
} from '../src/lib/security/event-loop';
import {
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
  isPrivateOrRestrictedHost,
  validateUrlForSsrf,
} from '../src/lib/security/ssrf';
import {
  getSanitizedEnvironment,
  generateSeccompBpfProfile,
  DANGEROUS_SYSCALL_FILTER_LIST,
  NETWORK_SYSCALL_FILTER_LIST,
  resolveSandboxedCommand,
} from '../src/lib/security/process-sandbox';
import { SandboxUnavailableError } from '../src/lib/types';

describe('Phase 4: Security Sandboxing, Event Loop & Zero-Trust Hardening', () => {
  describe('1. Cooperative Event Loop & Starvation Prevention', () => {
    it('yields execution back to the libuv event loop', async () => {
      let flag = false;
      setImmediate(() => {
        flag = true;
      });

      expect(flag).toBe(false);
      await yieldToEventLoop();
      expect(flag).toBe(true);
    });

    it('measures non-negative event loop lag in milliseconds', async () => {
      const lag = await measureEventLoopLag();
      expect(typeof lag).toBe('number');
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThan(1000);
    });

    it('iterates through collections with periodic event loop yields', async () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      const processed: number[] = [];
      let yieldCount = 0;

      // Wrap setImmediate to verify libuv yields occur periodically
      const originalSetImmediate = globalThis.setImmediate;
      const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((fn: any, ...args: any[]) => {
        yieldCount++;
        return originalSetImmediate(fn, ...args);
      });

      try {
        await forEachCooperative(items, 3, async (item) => {
          processed.push(item);
        });

        expect(processed).toEqual(items);
        // For 10 items and batch size 3: yields at index 2, 5, 8 (3 yields total)
        expect(yieldCount).toBe(3);
      } finally {
        setImmediateSpy.mockRestore();
      }
    });

    it('EventLoopMonitor tracks lag and emits threshold warning callback', async () => {
      const onLagExceeded = vi.fn();
      const monitor = new EventLoopMonitor({
        checkIntervalMs: 20,
        lagThresholdMs: 5,
        onLagExceeded,
      });

      monitor.start();
      expect(monitor.getActive()).toBe(true);

      // Artificially block the thread briefly to simulate heavy synchronous CPU task
      const start = Date.now();
      while (Date.now() - start < 45) {
        // busy wait
      }

      await new Promise((resolve) => setTimeout(resolve, 60));
      monitor.stop();

      expect(monitor.getActive()).toBe(false);
      expect(monitor.getLastLagMs()).toBeGreaterThanOrEqual(0);
      expect(onLagExceeded).toHaveBeenCalled();
    });
  });

  describe('2. Comprehensive SSRF Matrix & Cloud Metadata Hardening', () => {
    it('blocks AWS, Azure, and GCP IMDSv1/v2 metadata endpoints', () => {
      expect(isBlockedIpv4('169.254.169.254')).toBe(true);
      expect(isBlockedIpv4('169.254.170.2')).toBe(true); // AWS ECS metadata
      expect(isBlockedIp('169.254.169.254')).toBe(true);
      expect(isPrivateOrRestrictedHost('169.254.169.254')).toBe(true);
      expect(isPrivateOrRestrictedHost('metadata.google.internal')).toBe(true);
      expect(isPrivateOrRestrictedHost('metadata.google.internal.')).toBe(true);
      expect(isPrivateOrRestrictedHost('instance-data')).toBe(true);
    });

    it('blocks Alibaba Cloud metadata endpoint (100.100.100.200)', () => {
      expect(isBlockedIpv4('100.100.100.200')).toBe(true);
      expect(isBlockedIp('100.100.100.200')).toBe(true);
      expect(isPrivateOrRestrictedHost('100.100.100.200')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 addresses representing restricted IP targets', () => {
      expect(isBlockedIpv6('::ffff:169.254.169.254')).toBe(true);
      expect(isBlockedIpv6('::ffff:127.0.0.1')).toBe(true);
      expect(isBlockedIpv6('::ffff:10.0.0.1')).toBe(true);
      expect(isBlockedIp('::ffff:192.168.1.1')).toBe(true);
    });

    it('blocks IPv4-compatible IPv6 addresses representing restricted IP targets', () => {
      expect(isBlockedIpv6('::169.254.169.254')).toBe(true);
      expect(isBlockedIpv6('::127.0.0.1')).toBe(true);
      expect(isBlockedIpv6('::10.0.0.1')).toBe(true);
      expect(isBlockedIpv6('::a9fe:a9fe')).toBe(true);
      expect(isBlockedIp('::169.254.169.254')).toBe(true);
      expect(isBlockedIp('::a9fe:a9fe')).toBe(true);
    });

    it('blocks IPv6 loopback variants, unspecified, and tunneling encapsulations', () => {
      expect(isBlockedIpv6('::1')).toBe(true);
      expect(isBlockedIpv6('0::1')).toBe(true);
      expect(isBlockedIpv6('::0001')).toBe(true);
      expect(isBlockedIpv6('0000::1')).toBe(true);
      expect(isBlockedIpv6('::')).toBe(true);
      expect(isBlockedIpv6('::0')).toBe(true);

      // IPv4-translated (64:ff9b::/96)
      expect(isBlockedIpv6('64:ff9b::169.254.169.254')).toBe(true);
      expect(isBlockedIpv6('64:ff9b::127.0.0.1')).toBe(true);

      // 6to4 encapsulation (2002::/16)
      expect(isBlockedIpv6('2002:a9fe:a9fe::')).toBe(true);
      expect(isBlockedIpv6('2002:7f00:0001::')).toBe(true);
    });

    it('blocks RFC 1918, RFC 3927, RFC 6598, loopback, and broadcast ranges', () => {
      // Loopback
      expect(isBlockedIpv4('127.0.0.1')).toBe(true);
      expect(isBlockedIpv4('127.1.2.3')).toBe(true);
      expect(isBlockedIpv6('::1')).toBe(true);

      // RFC 1918
      expect(isBlockedIpv4('10.0.0.1')).toBe(true);
      expect(isBlockedIpv4('172.16.0.1')).toBe(true);
      expect(isBlockedIpv4('172.31.255.255')).toBe(true);
      expect(isBlockedIpv4('192.168.1.254')).toBe(true);

      // Carrier-Grade NAT (RFC 6598)
      expect(isBlockedIpv4('100.64.0.1')).toBe(true);
      expect(isBlockedIpv4('100.127.255.255')).toBe(true);

      // Link-local (RFC 3927)
      expect(isBlockedIpv4('169.254.1.1')).toBe(true);
      expect(isBlockedIpv6('fe80::1')).toBe(true);

      // Multicast / Reserved
      expect(isBlockedIpv4('224.0.0.1')).toBe(true);
      expect(isBlockedIpv4('255.255.255.255')).toBe(true);
    });

    it('allows valid public routable IPv4 and IPv6 addresses', () => {
      expect(isBlockedIpv4('93.184.216.34')).toBe(false); // example.com
      expect(isBlockedIpv4('8.8.8.8')).toBe(false);
      expect(isBlockedIpv4('1.1.1.1')).toBe(false);
      expect(isBlockedIpv6('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
      expect(isBlockedIpv6('2001:4860:4860::8888')).toBe(false);
      expect(isBlockedIpv6('2600:9000::1')).toBe(false);
    });

    it('validateUrlForSsrf rejects dangerous URLs with private, IPv6, or metadata hosts', async () => {
      expect(await validateUrlForSsrf(new URL('http://169.254.169.254/latest/meta-data'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://[::169.254.169.254]/latest/meta-data'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://metadata.google.internal/computeMetadata/v1'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://metadata.google.internal./computeMetadata/v1'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://localhost:8080/admin'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://localhost.:8080/admin'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://127.0.0.1:6379'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://[::127.0.0.1]/admin'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://[0::1]/admin'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://10.0.0.5/secrets'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://server.local/internal'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://server.local./internal'))).toBe(false);
    });
  });

  describe('3. Multi-Stage OCI Container & Defense-in-Depth Specification', () => {
    it('verifies Dockerfile.worker multi-stage builder and runner configuration', () => {
      const stages = parseDockerfile(fs.readFileSync(path.resolve(__dirname, '../Dockerfile.worker'), 'utf-8'));

      // The image is built in stages and the one that ships is the last: the runner.
      expect(stages.map((stage) => stage.name)).toEqual(['builder', 'sevenzip', 'runner']);
      const runner = stages[stages.length - 1];
      const instructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword);

      // The runner installs tini and starts through it (exec form, so signals reach tini as PID 1).
      expect(instructions('RUN').some((run) => /apt-get install[^&]*\btini\b/.test(run.argument))).toBe(true);
      const entrypoint = instructions('ENTRYPOINT');
      expect(entrypoint).toHaveLength(1);
      expect(execForm(entrypoint[0])).toEqual(['/usr/bin/tini', '-g', '--']);

      // The service account has a fixed uid and gid, is created before it is used, and is the last USER.
      const accountRun = instructions('RUN').find((run) => run.argument.includes('useradd'));
      expect(accountRun?.argument).toContain('groupadd -g 10001 -r easyconvert');
      expect(accountRun?.argument).toContain('useradd -u 10001 -r -g easyconvert');
      const users = instructions('USER');
      expect(users[users.length - 1].argument).toBe('easyconvert:easyconvert');
      expect(users[users.length - 1].index).toBeGreaterThan(accountRun!.index);
      expect(users.some((user) => user.argument === 'root')).toBe(false);
    });

    it('verifies docker-compose.yml security directives (init, cap_drop, no-new-privileges)', () => {
      const compose = loadYaml(fs.readFileSync(path.resolve(__dirname, '../docker-compose.yml'), 'utf-8')) as {
        services: Record<string, Record<string, unknown>>;
      };
      const worker = compose.services.worker;

      // Values come from the parsed service: comments in the file mention some of these words.
      expect(worker.init).toBe(true);
      expect(worker.cap_drop).toEqual(['ALL']);
      expect(worker.security_opt).toEqual(['no-new-privileges:true']);
      expect(worker.read_only).toBe(true);
      // /tmp is a size-capped tmpfs that cannot run binaries or carry setuid files.
      expect(worker.tmpfs).toContain('/tmp:size=8g,noexec,nosuid');
      expect(worker.volumes).not.toContain('worker-tmp:/tmp');
    });
  });

  describe('4. Process Sandbox Environment Sanitization & Syscall Guards', () => {
    it('purges secrets, keys, and tokens from child process environment', () => {
      const dirtyEnv = {
        REDIS_URL: 'redis://secret:pass@localhost:6379',
        AWS_SECRET_ACCESS_KEY: 'super_secret_aws_key',
        API_KEY: 'ec_live_12345678',
        DATABASE_URL: 'postgres://user:pass@db:5432/db',
        SAFE_SETTING: 'active',
      };

      const sanitized = getSanitizedEnvironment(dirtyEnv);
      expect(sanitized.SAFE_SETTING).toBe('active');
      expect(sanitized.REDIS_URL).toBeUndefined();
      expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(sanitized.API_KEY).toBeUndefined();
      expect(sanitized.DATABASE_URL).toBeUndefined();

      // Verify proxy poisoning for network isolation
      expect(sanitized.HTTP_PROXY).toBe('http://127.0.0.1:0');
      expect(sanitized.HTTPS_PROXY).toBe('http://127.0.0.1:0');
    });

    it('generates defensive Seccomp BPF filter profile with dangerous syscalls', () => {
      const profile = generateSeccompBpfProfile({ blockNetwork: true });
      expect(profile.defaultAction).toBe('SCMP_ACT_ALLOW');
      expect(profile.killAction).toBe('SCMP_ACT_ERRNO');

      for (const syscall of DANGEROUS_SYSCALL_FILTER_LIST) {
        expect(profile.blockedSyscalls).toContain(syscall);
      }
      for (const syscall of NETWORK_SYSCALL_FILTER_LIST) {
        expect(profile.blockedSyscalls).toContain(syscall);
      }
    });

    it('fails closed when strictIsolation is demanded on non-Linux platform', () => {
      const originalPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        expect(() => {
          resolveSandboxedCommand('/bin/echo', ['hello'], {
            networkIsolated: true,
            strictIsolation: true,
          });
        }).toThrow(SandboxUnavailableError);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });
});
