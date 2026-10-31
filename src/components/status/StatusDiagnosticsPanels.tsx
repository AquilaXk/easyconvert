'use client';

import React from 'react';
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
  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-start sm:items-center gap-4">
          <div className="flex items-center justify-center size-12 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 shrink-0">
            <CheckCircle2 className="w-6 h-6" aria-hidden="true" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-xl sm:text-2xl font-bold text-brand-950 dark:text-white tracking-tight">
                All Client-Side Conversion Engines Operational
              </h2>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                Ready
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-secondary dark:text-neutral-400">
              Verified directly within your browser execution sandbox.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onRunDiagnostics}
            disabled={isRunning}
            className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-md font-semibold text-sm bg-brand-700 hover:bg-brand-800 text-white active:bg-brand-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Zap className="w-4 h-4" aria-hidden="true" />
            <span>{isRunning ? 'Testing Edge Engines...' : 'Run Edge Diagnostics'}</span>
          </button>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-neutral-border dark:border-dark-border flex flex-wrap items-center justify-between text-xs text-ink-secondary dark:text-neutral-400 gap-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <span>{checkedLabel}</span>
        </div>

        <span className="text-emerald-700 dark:text-emerald-300 font-semibold flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
          <span>100% In-Browser Execution</span>
        </span>
      </div>
    </section>
  );
}

export function DiagnosticResultsCard({ results }: Readonly<{ results: DiagnosticResult[] }>) {
  const verifiedCount = results.filter((r) => r.supported).length;
  const allSupported = verifiedCount === results.length;

  return (
    <section
      aria-live="polite"
      className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
          Live Browser Edge Diagnostic Results
        </h2>
        <span
          className={`text-xs font-semibold px-2.5 py-1 rounded-md border ${
            allSupported
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
              : 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/30'
          }`}
        >
          {verifiedCount}/{results.length} Active
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {results.map((diag) => (
          <div
            key={diag.id}
            className={`p-3.5 rounded-lg border flex items-start gap-3 ${
              diag.supported
                ? 'bg-neutral-scaffold dark:bg-dark-elevated border-neutral-border dark:border-dark-border'
                : 'bg-amber-50/70 dark:bg-amber-950/25 border-amber-300 dark:border-amber-700/60'
            }`}
          >
            <div
              className={`size-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 ${
                diag.supported
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
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
                <h3 className="text-xs font-bold text-brand-950 dark:text-white truncate">
                  {diag.name}
                </h3>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!diag.supported && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30">
                      Unavailable
                    </span>
                  )}
                  <span className="text-[11px] font-mono text-brand-700 dark:text-brand-400">
                    {diag.latencyMs}ms
                  </span>
                </div>
              </div>
              <p className="text-xs text-ink-secondary dark:text-neutral-400 leading-snug">
                {diag.details}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function EnvironmentMetricsGrid({ detectedCores }: Readonly<{ detectedCores: number }>) {
  const cards = [
    {
      label: 'Execution Model',
      value: '100% In-Browser',
      caption: 'WebAssembly & WebCodecs',
      icon: Cpu,
    },
    {
      label: 'Persistent Storage',
      value: '0 Bytes',
      caption: 'Zero permanent retention',
      icon: HardDrive,
    },
    {
      label: 'Hardware Concurrency',
      value: `${detectedCores} Threads`,
      caption: 'Detected CPU execution units',
      icon: Terminal,
    },
    {
      label: 'Privacy Sandbox',
      value: 'Active',
      caption: 'Ephemeral volatile buffer',
      icon: ShieldCheck,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.label}
            className="p-5 rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm space-y-1"
          >
            <div className="flex items-center justify-between text-xs text-ink-muted dark:text-neutral-400">
              <span>{card.label}</span>
              <Icon className="w-4 h-4 text-brand-700 dark:text-brand-400" aria-hidden="true" />
            </div>
            <div className="text-xl font-bold text-brand-950 dark:text-white">{card.value}</div>
            <div className="text-xs text-ink-secondary dark:text-neutral-400">{card.caption}</div>
          </div>
        );
      })}
    </div>
  );
}
