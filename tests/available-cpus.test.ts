import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { availableCpus, parseCgroupCpuMax, parseCgroupV1CpuQuota } from '../src/lib/workers/available-cpus';

describe('parseCgroupCpuMax', () => {
  it('rounds a fractional cgroup v2 CPU quota up to the next whole core, at least 1', () => {
    expect(parseCgroupCpuMax('250000 100000\n')).toBe(3);
    expect(parseCgroupCpuMax('80000 100000\n')).toBe(1);
    expect(parseCgroupCpuMax('400000 100000\n')).toBe(4);
    expect(parseCgroupCpuMax('50000 100000')).toBe(1);
  });

  it('returns null when cpu.max is unconstrained ("max") or malformed', () => {
    expect(parseCgroupCpuMax('max 100000\n')).toBeNull();
    expect(parseCgroupCpuMax('')).toBeNull();
    expect(parseCgroupCpuMax('100000')).toBeNull();
    expect(parseCgroupCpuMax('0 100000')).toBeNull();
    expect(parseCgroupCpuMax('100000 0')).toBeNull();
    expect(parseCgroupCpuMax('-1 100000')).toBeNull();
    expect(parseCgroupCpuMax('abc 100000')).toBeNull();
  });
});

describe('parseCgroupV1CpuQuota', () => {
  it('parses cgroup v1 cfs_quota_us and cfs_period_us and returns null when unbounded (-1)', () => {
    expect(parseCgroupV1CpuQuota('250000\n', '100000\n')).toBe(3);
    expect(parseCgroupV1CpuQuota('80000\n', '100000\n')).toBe(1);
    expect(parseCgroupV1CpuQuota('-1\n', '100000\n')).toBeNull();
    expect(parseCgroupV1CpuQuota('0\n', '100000\n')).toBeNull();
  });
});

describe('availableCpus', () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function makeTempCgroup(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cgroup-cpu-test-'));
    tempDirs.push(dir);
    return dir;
  }

  it('caps the host core count by cgroup v2 cpu.max when a quota is set', () => {
    const dir = makeTempCgroup();
    const cpuMaxPath = path.join(dir, 'cpu.max');
    writeFileSync(cpuMaxPath, '250000 100000\n');
    expect(availableCpus({ cpuMaxPath, hostCores: 16 })).toBe(3);
    expect(availableCpus({ cpuMaxPath, hostCores: 2 })).toBe(2);

    writeFileSync(cpuMaxPath, '80000 100000\n');
    expect(availableCpus({ cpuMaxPath, hostCores: 8 })).toBe(1);
  });

  it('falls back to cgroup v1 when cgroup v2 is absent or unconstrained, and to hostCores when both are unconstrained', () => {
    const dir = makeTempCgroup();
    const cpuMaxPath = path.join(dir, 'cpu.max');
    const v1QuotaPath = path.join(dir, 'cpu.cfs_quota_us');
    const v1PeriodPath = path.join(dir, 'cpu.cfs_period_us');

    writeFileSync(cpuMaxPath, 'max 100000\n');
    writeFileSync(v1QuotaPath, '200000\n');
    writeFileSync(v1PeriodPath, '100000\n');
    expect(availableCpus({ cpuMaxPath, v1QuotaPath, v1PeriodPath, hostCores: 8 })).toBe(2);

    writeFileSync(v1QuotaPath, '-1\n');
    expect(availableCpus({ cpuMaxPath, v1QuotaPath, v1PeriodPath, hostCores: 8 })).toBe(8);

    const missing = path.join(dir, 'does-not-exist');
    expect(availableCpus({ cpuMaxPath: missing, v1QuotaPath: missing, v1PeriodPath: missing, hostCores: 6 })).toBe(6);
  });

  it('memoizes the default host/cgroup core count when called without custom options', () => {
    const first = availableCpus();
    const second = availableCpus();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(first);
  });
});
