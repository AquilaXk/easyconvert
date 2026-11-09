import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { instruments } from '../src/lib/metrics/instruments';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf-8');

interface AlertRule {
  alert: string;
  expr: string;
  for: string;
  labels: Record<string, string>;
  annotations: {
    summary: string;
    description: string;
    runbook: string;
  };
}

interface AlertRuleGroup {
  name: string;
  interval?: string;
  rules: AlertRule[];
}

interface AlertRulesDocument {
  groups: AlertRuleGroup[];
}

const normalizePromql = (expr: string): string => expr.replace(/\s+/g, ' ').trim();

describe('deploy/oci/prometheus-alerts.yml and runbook links', () => {
  const doc = parse(read('deploy/oci/prometheus-alerts.yml')) as AlertRulesDocument;
  const group = doc.groups.find((entry) => entry.name === 'easyconvert');
  const rulesByName = new Map((group?.rules ?? []).map((rule) => [rule.alert, rule]));

  it('defines the easyconvert rule group with the three paging alerts', () => {
    expect(group).toBeDefined();
    expect(group?.rules.map((rule) => rule.alert)).toEqual([
      'EasyConvertErrorBudgetBurn',
      'EasyConvertQueueAgeHigh',
      'EasyConvertWorkerRestarts',
    ]);
    for (const rule of group?.rules ?? []) {
      expect(rule.labels).toEqual({ severity: 'page' });
      expect(rule.annotations.summary.length).toBeGreaterThan(10);
      expect(rule.annotations.description.length).toBeGreaterThan(20);
    }
  });

  it('evaluates multi-window 14.4x error budget burn across HTTP requests and queue jobs by family', () => {
    const rule = rulesByName.get('EasyConvertErrorBudgetBurn');
    expect(rule).toBeDefined();
    expect(rule?.for).toBe('5m');
    expect(rule?.annotations.runbook).toBe('docs/operations/alerts.md#alert-error-budget-burn');
    expect(normalizePromql(rule?.expr ?? '')).toBe(
      normalizePromql(`(
        sum by (family) (
          increase(easyconvert_http_requests_total{outcome=~"failed|timed_out"}[1h])
          or increase(easyconvert_jobs_total{outcome=~"failed|timed_out"}[1h])
        )
        /
        clamp_min(
          sum by (family) (
            increase(easyconvert_http_requests_total{outcome=~"ok|failed|timed_out"}[1h])
            or increase(easyconvert_jobs_total{outcome=~"ok|failed|timed_out"}[1h])
          ),
          1
        ) > 0.072
        and
        sum by (family) (
          increase(easyconvert_http_requests_total{outcome=~"ok|failed|timed_out"}[1h])
          or increase(easyconvert_jobs_total{outcome=~"ok|failed|timed_out"}[1h])
        ) >= 20
        and
        sum by (family) (
          increase(easyconvert_http_requests_total{outcome=~"failed|timed_out"}[6h])
          or increase(easyconvert_jobs_total{outcome=~"failed|timed_out"}[6h])
        )
        /
        clamp_min(
          sum by (family) (
            increase(easyconvert_http_requests_total{outcome=~"ok|failed|timed_out"}[6h])
            or increase(easyconvert_jobs_total{outcome=~"ok|failed|timed_out"}[6h])
          ),
          1
        ) > 0.072
      )`)
    );
  });

  it('pages when the oldest waiting job in any queue exceeds 300s or no worker target is up', () => {
    const rule = rulesByName.get('EasyConvertQueueAgeHigh');
    expect(rule).toBeDefined();
    expect(rule?.for).toBe('5m');
    expect(rule?.annotations.runbook).toBe('docs/operations/alerts.md#alert-queue-age');
    expect(normalizePromql(rule?.expr ?? '')).toBe(
      normalizePromql(`
        max by (queue) (easyconvert_queue_oldest_waiting_age_seconds) > 300
        or max(up{job="easyconvert-worker"}) == 0
      `)
    );
  });

  it('pages when a worker restarts 3 or more times within 15 minutes', () => {
    const rule = rulesByName.get('EasyConvertWorkerRestarts');
    expect(rule).toBeDefined();
    expect(rule?.for).toBe('0m');
    expect(rule?.annotations.runbook).toBe('docs/operations/alerts.md#alert-worker-restarts');
    expect(normalizePromql(rule?.expr ?? '')).toBe(
      'changes(process_start_time_seconds{job="easyconvert-worker"}[15m]) >= 3'
    );
  });

  it('references only easyconvert_* metrics that are registered on the process metrics registry', async () => {
    const registered = new Set((await instruments().registry.getMetricsAsJSON()).map((metric) => metric.name));
    const referenced = new Set<string>();
    for (const rule of group?.rules ?? []) {
      for (const match of rule.expr.matchAll(/\beasyconvert_[a-z0-9_]+\b/g)) {
        referenced.add(match[0]);
      }
    }
    expect([...referenced].sort()).toEqual([
      'easyconvert_http_requests_total',
      'easyconvert_jobs_total',
      'easyconvert_queue_oldest_waiting_age_seconds',
    ]);
    for (const metricName of referenced) {
      expect(registered.has(metricName), metricName).toBe(true);
    }
    expect(registered.has('process_start_time_seconds')).toBe(true);
  });

  it('links each alert runbook annotation to an explicit anchor in docs/operations/alerts.md and cross-references the rule file from docs/slo.md', () => {
    const runbookDoc = read('docs/operations/alerts.md');
    const sloDoc = read('docs/slo.md');
    expect(runbookDoc).toContain('deploy/oci/prometheus-alerts.yml');
    expect(sloDoc).toContain('deploy/oci/prometheus-alerts.yml');

    const anchors = new Set([...runbookDoc.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1]));
    for (const rule of group?.rules ?? []) {
      const [filePath, anchor] = rule.annotations.runbook.split('#');
      expect(filePath).toBe('docs/operations/alerts.md');
      expect(anchor).toBeTruthy();
      expect(anchors.has(anchor), `anchor #${anchor} in docs/operations/alerts.md`).toBe(true);
      expect(runbookDoc).toContain(rule.annotations.runbook);
      expect(sloDoc).toContain(rule.alert);
      expect(sloDoc).toContain(`operations/alerts.md#${anchor}`);
    }
  });
});
