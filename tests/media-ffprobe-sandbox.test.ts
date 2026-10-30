import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ffprobe reads every uploaded media file before FFmpeg does, so it runs in the same namespace sandbox: a network namespace
 * of its own under STRICT_SANDBOX, and no process at all when the host cannot give one. The ffmpeg and ffprobe binaries here
 * are spies that record the namespaces they were started in.
 */
const host = vi.hoisted(() => ({ denyUnshare: false }));
const UNSHARE_EPERM_STATUS = 1;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((file: string, ...rest: unknown[]) => {
    if (host.denyUnshare && file.endsWith('/unshare')) {
      throw Object.assign(new Error('unshare: unshare failed: Operation not permitted'), { status: UNSHARE_EPERM_STATUS });
    }
    return (actual.execFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.execFileSync;
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { type FfprobePath, probeInput, resetInputProbeCache } from '../src/lib/conversions/media-ffprobe';
import { openMediaInput } from '../src/lib/conversions/media-process';
import { getUnshareCapability, resetUnshareCapabilityCache } from '../src/lib/security/process-sandbox';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { skipUnless } from './helpers/strict-skip';

const HTTP_SERVICE_UNAVAILABLE = 503;
const CONVERT_TIMEOUT_MS = 60_000;
const SPY_MODE = 0o755;
const SPY_FAILURE_STATUS = 3;
const SAMPLE_MP4_PATH = path.resolve(__dirname, 'fixtures', 'sample.mp4');
const SAMPLE_MP4 = readFileSync(SAMPLE_MP4_PATH);
const ON_LINUX = process.platform === 'linux';

let spyDir = '';
let spyLog = '';

/** One line per spy start: the tool, its network namespace, its user id, then its arguments. */
function spawnedTools(): string[] {
  return existsSync(spyLog) ? readFileSync(spyLog, 'utf-8').split('\n').filter(Boolean) : [];
}

function writeSpy(name: string): string {
  const spy = path.join(spyDir, name);
  writeFileSync(spy, `#!/bin/sh\necho "${name} $(readlink /proc/self/ns/net 2>/dev/null) $(id -u) $*" >> "${spyLog}"\nexit ${SPY_FAILURE_STATUS}\n`);
  chmodSync(spy, SPY_MODE);
  return spy;
}

beforeAll(() => {
  spyDir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-ffprobe-spy-'));
  spyLog = path.join(spyDir, 'invocations.log');
  writeSpy('ffmpeg');
  writeSpy('ffprobe');
});

afterAll(() => {
  rmSync(spyDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(spyLog, { force: true });
  vi.stubEnv('FFMPEG_PATH', path.join(spyDir, 'ffmpeg'));
  vi.stubEnv('FFPROBE_PATH', path.join(spyDir, 'ffprobe'));
  resetUnshareCapabilityCache();
  resetInputProbeCache();
});

afterEach(() => {
  host.denyUnshare = false;
  vi.unstubAllEnvs();
  resetUnshareCapabilityCache();
});

describe.skipIf(skipUnless('unprivileged namespaces (unshare -r -n)', ON_LINUX && getUnshareCapability().available))(
  'ffprobe under STRICT_SANDBOX with the namespace sandbox available',
  () => {
    it('starts ffprobe in a network namespace of its own, as the mapped root of a user namespace (unshare -r -n)', () => {
      vi.stubEnv('STRICT_SANDBOX', 'true');
      expect(() => probeInput(openMediaInput(SAMPLE_MP4_PATH, 'mp4'), path.join(spyDir, 'ffprobe') as FfprobePath)).toThrow();
      const probes = spawnedTools().filter((line) => line.startsWith('ffprobe '));
      expect(probes.length).toBeGreaterThan(0);
      const ownNetwork = readlinkSync('/proc/self/ns/net');
      for (const line of probes) {
        const [, network, uid] = line.split(' ');
        expect(network).toMatch(/^net:\[\d+\]$/);
        expect(network).not.toBe(ownNetwork);
        expect(uid).toBe('0');
      }
    });
  }
);

describe('a media conversion under STRICT_SANDBOX with the namespace sandbox unavailable', () => {
  let secretKey: string;

  beforeEach(async () => {
    const user = await userStore.createUser({
      name: 'Media Sandbox 503 Tester',
      email: `media503_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Media Sandbox 503 Key', { scopes: ['convert:write', 'convert:read'] });
    secretKey = key.secretKey;
  });

  function mp4ToMp3Request(): NextRequest {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(SAMPLE_MP4)]), 'sample.mp4');
    form.append('targetFormat', 'mp3');
    return new NextRequest('http://localhost/api/v1/convert', { method: 'POST', headers: { Authorization: `Bearer ${secretKey}` }, body: form });
  }

  it(
    'answers 503 and never starts ffprobe or ffmpeg',
    async () => {
      // Linux refuses through the capability probe that fails; any other platform has no network namespaces at all.
      host.denyUnshare = ON_LINUX;
      vi.stubEnv('STRICT_SANDBOX', 'true');
      const res = await v1ConvertPost(mp4ToMp3Request());
      expect(res.status).toBe(HTTP_SERVICE_UNAVAILABLE);
      expect(spawnedTools()).toEqual([]);
    },
    CONVERT_TIMEOUT_MS
  );
});
