import { readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * Available CPU cores for sizing worker pools, encoder threads, and child processes inside containers.
 *
 * Reference:
 * - Linux kernel cgroup v2 CPU controller (`Documentation/admin-guide/cgroup-v2.rst`, `cpu.max`: `<quota> <period>`
 *   in microseconds, or `max <period>` when unbounded).
 * - Linux kernel cgroup v1 CFS bandwidth controller (`Documentation/scheduler/sched-bwc.rst`,
 *   `cpu.cfs_quota_us` and `cpu.cfs_period_us`, where `-1` means unbounded).
 * - OpenJDK `src/hotspot/os/linux/cgroupV2Subsystem_linux.cpp` and `OSContainer_linux.cpp`
 *   (`active_processor_count`: `ceil(quota / period)` bounded by host processors, at least 1).
 */

export const CGROUP_V2_CPU_MAX_PATH = '/sys/fs/cgroup/cpu.max';
export const CGROUP_V1_QUOTA_PATH = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
export const CGROUP_V1_PERIOD_PATH = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

const POSITIVE_INTEGER = /^\d+$/;

/**
 * Parses the contents of a cgroup v2 `cpu.max` file (`"<quota> <period>"`) into a whole core count
 * (`Math.max(1, Math.ceil(quota / period))`), or returns `null` when the quota is `"max"` or malformed.
 */
export function parseCgroupCpuMax(raw: string): number | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [quotaText, periodText] = parts;
  if (quotaText === 'max') return null;
  if (!POSITIVE_INTEGER.test(quotaText) || !POSITIVE_INTEGER.test(periodText)) return null;
  const quota = Number(quotaText);
  const period = Number(periodText);
  if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(period) || quota <= 0 || period <= 0) {
    return null;
  }
  return Math.max(1, Math.ceil(quota / period));
}

/**
 * Parses cgroup v1 `cpu.cfs_quota_us` and `cpu.cfs_period_us` text into a whole core count, or `null`
 * when unbounded (`-1`) or malformed.
 */
export function parseCgroupV1CpuQuota(quotaRaw: string, periodRaw: string): number | null {
  const quotaText = quotaRaw.trim();
  const periodText = periodRaw.trim();
  if (quotaText === '-1' || !POSITIVE_INTEGER.test(quotaText) || !POSITIVE_INTEGER.test(periodText)) {
    return null;
  }
  const quota = Number(quotaText);
  const period = Number(periodText);
  if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(period) || quota <= 0 || period <= 0) {
    return null;
  }
  return Math.max(1, Math.ceil(quota / period));
}

export interface AvailableCpusOptions {
  cpuMaxPath?: string;
  v1QuotaPath?: string;
  v1PeriodPath?: string;
  hostCores?: number;
}

let cachedDefaultCpus: number | null = null;

function computeAvailableCpus(options: AvailableCpusOptions): number {
  const host = Math.max(1, Math.floor(options.hostCores ?? os.availableParallelism()));
  const cpuMaxPath = options.cpuMaxPath ?? CGROUP_V2_CPU_MAX_PATH;
  try {
    const v2Cores = parseCgroupCpuMax(readFileSync(cpuMaxPath, 'utf-8'));
    if (v2Cores !== null) return Math.max(1, Math.min(host, v2Cores));
  } catch {
    // Non-Linux host or no cgroup v2 mount; try cgroup v1 below.
  }
  const v1QuotaPath = options.v1QuotaPath ?? CGROUP_V1_QUOTA_PATH;
  const v1PeriodPath = options.v1PeriodPath ?? CGROUP_V1_PERIOD_PATH;
  try {
    const v1Cores = parseCgroupV1CpuQuota(readFileSync(v1QuotaPath, 'utf-8'), readFileSync(v1PeriodPath, 'utf-8'));
    if (v1Cores !== null) return Math.max(1, Math.min(host, v1Cores));
  } catch {
    // No cgroup v1 mount; fall back to host parallelism.
  }
  return host;
}

/**
 * Reads the container CPU quota from cgroup v2 (`cpu.max`) or cgroup v1 (`cpu.cfs_quota_us` / `cpu.cfs_period_us`)
 * and bounds it by `os.availableParallelism()`, returning at least 1 core.
 * When called without custom options, the resolved value is memoized for the process lifetime so hot paths do not
 * issue repeated synchronous `fs.readFileSync` syscalls.
 */
export function availableCpus(options?: AvailableCpusOptions): number {
  if (
    !options ||
    (options.cpuMaxPath === undefined &&
      options.v1QuotaPath === undefined &&
      options.v1PeriodPath === undefined &&
      options.hostCores === undefined)
  ) {
    if (cachedDefaultCpus === null) {
      cachedDefaultCpus = computeAvailableCpus({});
    }
    return cachedDefaultCpus;
  }
  return computeAvailableCpus(options);
}
