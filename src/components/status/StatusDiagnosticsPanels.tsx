'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Cpu,
  HardDrive,
  ShieldCheck,
  Terminal,
  Zap,
} from 'lucide-react';
import type { DiagnosticResult } from './status-probes';

export function StatusOverviewCard({
  isRunning,
  checkedLabel,
  onRunDiagnostics,
}: Readonly<{
  isRunning: boolean;
  checkedLabel: string;
  onRunDiagnostics: () => void;
}>) {
  const t = useTranslations('status.overview');
  return (
    <section className="border-t border-rule-strong pt-6 sm:pt-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-start sm:items-center gap-4">
          <div className="flex items-center justify-center size-12 text-success shrink-0">
            <CheckCircle2 className="w-6 h-6" aria-hidden="true" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-2xl sm:text-3xl text-ink">
                {t('heading')}
              </h2>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-sm text-xs font-semibold bg-success/10 text-success border border-success-edge/30">
                {t('ready')}
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-2">
              {t('intro')}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onRunDiagnostics}
            disabled={isRunning}
            className="lift inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-sm font-semibold text-sm bg-accent hover:bg-accent-hover hover:shadow-glow text-on-accent active:bg-accent-press disabled:opacity-50 cursor-pointer"
          >
            <Zap className="w-4 h-4" aria-hidden="true" />
            <span>{isRunning ? t('running') : t('run')}</span>
          </button>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-rule flex flex-wrap items-center justify-between text-xs text-ink-2 gap-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-success" aria-hidden="true" />
          <span>{checkedLabel}</span>
        </div>

        <span className="text-success font-semibold flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-success" aria-hidden="true" />
          <span>{t('inBrowser')}</span>
        </span>
      </div>
    </section>
  );
}

export function DiagnosticResultsCard({ results }: Readonly<{ results: DiagnosticResult[] }>) {
  const t = useTranslations('status.diagnostics');
  const verifiedCount = results.filter((r) => r.supported).length;
  const allSupported = verifiedCount === results.length;

  return (
    <section className="border-t border-rule-strong pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-lg sm:text-xl text-ink">
          {t('heading')}
        </h2>
        <span
          className={`text-xs font-semibold px-2.5 py-1 rounded-sm border ${
            allSupported
              ? 'bg-success/10 text-success border-success-edge/20'
              : 'bg-warning/10 text-warning border-warning-edge/30'
          }`}
        >
          {t('activeCount', { active: verifiedCount, total: results.length })}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {results.map((diag) => (
          <div
            key={diag.id}
            className={`p-3.5 rounded-md border flex items-start gap-3 ${
              diag.supported
                ? 'border-rule'
                : 'bg-warning-soft/70 border-warning-edge'
            }`}
          >
            <div
              className={`size-6 rounded-sm flex items-center justify-center shrink-0 mt-0.5 ${
                diag.supported
                  ? 'text-success'
                  : 'text-warning'
              }`}
            >
              {diag.supported ? (
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </div>
            <div className="space-y-0.5 flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-bold text-ink truncate">
                  {t(`probes.${diag.id}.name`)}
                </h3>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!diag.supported && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-warning/15 text-warning border border-warning-edge/30">
                      {t('unavailable')}
                    </span>
                  )}
                  <span className="text-[11px] font-mono text-accent-ink">
                    {diag.latencyMs}ms
                  </span>
                </div>
              </div>
              <p className="text-xs text-ink-2 leading-snug">
                {t(`probes.${diag.id}.${diag.supported ? 'supported' : 'unsupported'}`, { cores: diag.cores ?? 0 })}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The environment metrics; each one's label, value and caption are `status.metrics.<key>` in the messages. */
const ENVIRONMENT_METRICS = [
  { key: 'execution', icon: Cpu },
  { key: 'storage', icon: HardDrive },
  { key: 'concurrency', icon: Terminal },
  { key: 'privacy', icon: ShieldCheck },
] as const;

export function EnvironmentMetricsGrid({ detectedCores }: Readonly<{ detectedCores: number }>) {
  const t = useTranslations('status.metrics');
  const cards = ENVIRONMENT_METRICS.map(({ key, icon }) => ({
    label: t(`${key}.label`),
    value: t(`${key}.value`, { cores: detectedCores }),
    caption: t(`${key}.caption`),
    icon,
  }));

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.label}
            className="border-t border-rule-strong pt-5 space-y-1"
          >
            <div className="flex items-center justify-between text-xs text-ink-3">
              <span>{card.label}</span>
              <Icon className="w-4 h-4 text-accent-ink" aria-hidden="true" />
            </div>
            <div className="text-xl font-bold text-ink">{card.value}</div>
            <div className="text-xs text-ink-2">{card.caption}</div>
          </div>
        );
      })}
    </div>
  );
}
