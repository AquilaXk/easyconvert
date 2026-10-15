import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { resolveNativeBinary, type NativeBinaryName } from '../../worker/engines';
import { resolveLocalStorageDir } from '../storage/storage-config';

/**
 * Live dependency probes behind GET /api/health.
 *
 * Readiness, not liveness: the endpoint answers "should this instance take traffic?". Only the
 * dependencies every request path needs decide that: Redis (when configured) and storage. Without
 * them no upload, job or download can work, so a failed probe answers 503.
 *
 * The native CLIs are advisory. A web instance may run without them (conversions then run on the
 * worker tier), and a missing CLI fails only the conversions that need it, with a typed 503 of its
 * own. Taking the whole instance out of rotation for one missing tool would turn a partial outage
 * into a full one. The admin view reports every CLI so operators see the gap. Redis is probed only
 * when it is configured, so local development without Redis stays healthy.
 *
 * Probes run in parallel, each under HEALTH_PROBE_TIMEOUT_MS, and the verdict is cached for
 * HEALTH_CACHE_TTL_MS so a load balancer polling every second costs one probe set per TTL. A
 * report names components and coarse reasons only: no path, host name, credential or error text.
 */

/** Longest a single probe may take before its component counts as failed. */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;
/** How long a probe result is reused. */
export const HEALTH_CACHE_TTL_MS = 5_000;
/** Object key the storage probe asks the object store about; it is never written and need not exist. */
export const HEALTH_STORAGE_CANARY_KEY = 'health/canary';

const DEFAULT_REDIS_PORT = 6379;
const PROBE_FILE_PREFIX = '.health-';
const REDIS_PONG = 'PONG';

export type HealthStatus = 'healthy' | 'unhealthy';
export type ComponentStatus = 'ok' | 'failed' | 'not_configured';
export type FailureReason = 'timeout' | 'unreachable' | 'missing' | 'not_writable' | 'misconfigured';

export interface ComponentReport {
  status: ComponentStatus;
  reason?: FailureReason;
  /** Storage only: the configured driver (`local`, `oci` or `s3`). */
  driver?: string;
  /** Whether a failure of this component makes the instance unhealthy (Redis, storage) or is advisory (CLIs). */
  required: boolean;
}

/** What one probe finds; whether it is required is decided when the report is assembled. */
type ProbeResult = Omit<ComponentReport, 'required'>;

export interface HealthReport {
  status: HealthStatus;
  checkedAt: string;
  components: Record<string, ComponentReport>;
}

/** A probe failed for a known, coarse reason. Anything else a probe throws is reported as unreachable. */
export class HealthProbeFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    readonly driver?: string
  ) {
    super(`health probe failed: ${reason}`);
    this.name = 'HealthProbeFailure';
  }
}

/** Binaries the conversions use, as `[component name, worker binary key]`. 7z is 7zz or 7z. Advisory. */
const ADVISORY_BINARIES: ReadonlyArray<readonly [string, NativeBinaryName]> = [
  ['soffice', 'soffice'],
  ['ffmpeg', 'ffmpeg'],
  ['ffprobe', 'ffprobe'],
  ['pdftoppm', 'pdftoppm'],
  ['pdftotext', 'pdftotext'],
  ['tesseract', 'tesseract'],
  ['7z', 'p7zip'],
  ['dcraw_emu', 'dcrawEmu'],
];

function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);
}

async function probeRedis(): Promise<ProbeResult> {
  if (!isRedisConfigured()) return { status: 'not_configured' };
  const options = {
    lazyConnect: true,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    maxRetriesPerRequest: 0,
    connectTimeout: HEALTH_PROBE_TIMEOUT_MS,
    commandTimeout: HEALTH_PROBE_TIMEOUT_MS,
    retryStrategy: () => null,
  };
  const url = process.env.REDIS_URL;
  const client = url
    ? new Redis(url, options)
    : new Redis({
        ...options,
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT ? Number.parseInt(process.env.REDIS_PORT, 10) : DEFAULT_REDIS_PORT,
      });
  // A refused or reset connection is reported through the rejected command, not through an unhandled event.
  client.on('error', () => undefined);
  try {
    await client.connect();
    if ((await client.ping()) !== REDIS_PONG) throw new HealthProbeFailure('unreachable');
    return { status: 'ok' };
  } finally {
    client.disconnect();
  }
}

/** Writes and removes an empty file: the only proof that the directory is writable on a read-only mount or ACL. */
async function assertDirectoryWritable(directory: string): Promise<void> {
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    const probeFile = path.join(directory, `${PROBE_FILE_PREFIX}${crypto.randomUUID()}`);
    await fs.promises.writeFile(probeFile, '', { flag: 'wx' });
    await fs.promises.rm(probeFile, { force: true });
  } catch {
    throw new HealthProbeFailure('not_writable');
  }
}

type StorageSelection = typeof import('../storage/selected-storage');

/**
 * Loads the storage selection outside any probe deadline, so a cold import is not mistaken for a
 * stall. Importing it validates STORAGE_DRIVER and its credentials: a bad deployment throws here,
 * which reads as unhealthy rather than failing the route.
 */
async function loadStorageSelection(): Promise<StorageSelection | undefined> {
  try {
    return await import('../storage/selected-storage');
  } catch {
    return undefined;
  }
}

async function probeStorage(selection: StorageSelection | undefined): Promise<ProbeResult> {
  if (!selection) throw new HealthProbeFailure('misconfigured');
  const driver = selection.storageConfig.driver;
  try {
    if (driver === 'local') {
      await assertDirectoryWritable(resolveLocalStorageDir());
    } else {
      // A HEAD on a key that does not exist answers "not found" without error: it proves endpoint, bucket and credentials.
      await selection.objectStorage.head(HEALTH_STORAGE_CANARY_KEY);
    }
  } catch (error) {
    if (error instanceof HealthProbeFailure) throw new HealthProbeFailure(error.reason, driver);
    throw new HealthProbeFailure('unreachable', driver);
  }
  return { status: 'ok', driver };
}

async function probeBinary(name: NativeBinaryName): Promise<ProbeResult> {
  const resolved = resolveNativeBinary(name);
  if (resolved === null) throw new HealthProbeFailure('missing');
  try {
    await fs.promises.access(resolved, fs.constants.X_OK);
  } catch {
    throw new HealthProbeFailure('missing');
  }
  return { status: 'ok' };
}

/** Runs one probe under the probe deadline and turns every outcome into a component report. */
async function runProbe(probe: () => Promise<ProbeResult>): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HealthProbeFailure('timeout')), HEALTH_PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(probe), deadline]);
  } catch (error) {
    if (error instanceof HealthProbeFailure) {
      return { status: 'failed', reason: error.reason, ...(error.driver ? { driver: error.driver } : {}) };
    }
    return { status: 'failed', reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Components whose failure makes the instance unhealthy. */
const REQUIRED_COMPONENTS: ReadonlySet<string> = new Set(['redis', 'storage']);

async function collectHealthReport(): Promise<HealthReport> {
  const storageSelection = await loadStorageSelection();
  const probes: Array<[string, () => Promise<ProbeResult>]> = [
    ['redis', probeRedis],
    ['storage', () => probeStorage(storageSelection)],
    ...ADVISORY_BINARIES.map(([component, name]): [string, () => Promise<ProbeResult>] => [
      component,
      () => probeBinary(name),
    ]),
  ];
  const results = await Promise.all(probes.map(([, probe]) => runProbe(probe)));
  const components: Record<string, ComponentReport> = {};
  let healthy = true;
  probes.forEach(([component], index) => {
    const required = REQUIRED_COMPONENTS.has(component);
    components[component] = { ...results[index], required };
    if (required && results[index].status === 'failed') {
      healthy = false;
    }
  });
  return { status: healthy ? 'healthy' : 'unhealthy', checkedAt: new Date().toISOString(), components };
}

let cached: { report: HealthReport; expiresAt: number } | undefined;
let inFlight: Promise<HealthReport> | undefined;

/** The current health verdict: probed at most once per HEALTH_CACHE_TTL_MS, and once at a time. */
export function getHealthReport(): Promise<HealthReport> {
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.report);
  inFlight ??= collectHealthReport()
    .then((report) => {
      cached = { report, expiresAt: Date.now() + HEALTH_CACHE_TTL_MS };
      return report;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

/** Drops the cached verdict; for tests. */
export function resetHealthCache(): void {
  cached = undefined;
}
