import { describe, expect, it } from 'vitest';
import { CATEGORY_ORDER } from '../src/lib/registry';
import { FAMILIES, OUTCOMES, onList, outcomeOfStatus } from '../src/lib/metrics/labels';
import { familyOfFormat } from '../src/lib/metrics/families';
import { observeJob, observeRequest, observeSandboxSpawnFailure, setQueueGauges } from '../src/lib/metrics/instruments';
import { allSamples, resetMetrics } from './helpers/metrics-readings';

/**
 * The labels of the service metrics come from closed lists, so a metric cannot grow a series per file, user or request
 * (docs/slo.md). The lists are written out in src/lib/metrics/labels.ts; these tests hold them to the registry and to what the
 * recorders do with a value that is not on a list.
 */

describe('the closed lists', () => {
  it('name every category of the format registry as a family, and one more for a source that is not known', () => {
    expect([...FAMILIES]).toEqual([...CATEGORY_ORDER, 'unknown']);
  });

  it('read the family from the registry category of the source format, and nothing else', () => {
    expect(familyOfFormat('pdf')).toBe('document');
    expect(familyOfFormat('PNG')).toBe('image');
    expect(familyOfFormat('mp4')).toBe('video');
    expect(familyOfFormat('csv')).toBe('data');
    expect(familyOfFormat('not-a-format')).toBe('unknown');
    expect(familyOfFormat('__proto__')).toBe('unknown');
    expect(familyOfFormat(undefined)).toBe('unknown');
    expect(familyOfFormat(42)).toBe('unknown');
  });

  it.each([
    [200, 'ok'],
    [202, 'ok'],
    [302, 'ok'],
    [400, 'refused'],
    [401, 'refused'],
    [413, 'refused'],
    [429, 'refused'],
    [499, 'refused'],
    [500, 'failed'],
    [503, 'failed'],
    [504, 'timed_out'],
  ])('map HTTP status %i to the outcome %s', (status, outcome) => {
    expect(outcomeOfStatus(status)).toBe(outcome);
  });

  it('give a value that is not on a list the fallback of the list', () => {
    expect(onList(OUTCOMES, 'ok', 'failed')).toBe('ok');
    expect(onList(OUTCOMES, 'someone@example.com', 'failed')).toBe('failed');
    expect(onList(OUTCOMES, undefined, 'failed')).toBe('failed');
  });
});

describe('a value that is not on a list never reaches a label', () => {
  const HOSTILE = ['quarterly-report.docx', 'user_8d41f2', '../../etc/passwd', 'a"b\nc', '/api/v1/jobs/3f1a9c', 'x'.repeat(5000)];

  it('records every hostile route, family, outcome, queue and reason as a fallback', async () => {
    resetMetrics();
    for (const hostile of HOSTILE) {
      observeRequest(hostile, hostile as never, hostile as never, 5);
      observeJob(hostile as never, hostile as never, 5);
      observeSandboxSpawnFailure(hostile as never);
      setQueueGauges(hostile as never, { waiting: 1, active: 0, delayed: 0 }, 0);
    }
    const samples = (await allSamples()).filter((sample) => sample.metricName.startsWith('easyconvert_'));
    expect(samples.length).toBeGreaterThan(0);
    const values = new Set(samples.flatMap((sample) => Object.entries(sample.labels).filter(([name]) => name !== 'le').map(([, value]) => value)));
    for (const hostile of HOSTILE) expect(values).not.toContain(hostile);
    expect([...values].sort()).toEqual(['active', 'default', 'delayed', 'failed', 'other', 'spawn_error', 'unknown', 'waiting'].sort());
  });
});
