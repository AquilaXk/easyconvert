'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Cpu } from 'lucide-react';
import {
  DiagnosticResultsCard,
  EnvironmentMetricsGrid,
  StatusOverviewCard,
} from '@/components/status/StatusDiagnosticsPanels';
import {
  CATEGORY_TABS,
  ENGINE_COMPONENTS,
  collectEdgeDiagnostics,
  type CategoryFilter,
  type ComponentStatus,
  type DiagnosticResult,
} from '@/components/status/status-probes';

function ComponentStatusSection({
  activeCategory,
  components,
  onSelectCategory,
}: Readonly<{
  activeCategory: CategoryFilter;
  components: ComponentStatus[];
  onSelectCategory: (category: CategoryFilter) => void;
}>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeTabId = `status-tab-${activeCategory}`;

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % CATEGORY_TABS.length;
    else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + CATEGORY_TABS.length) % CATEGORY_TABS.length;
    } else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = CATEGORY_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    onSelectCategory(CATEGORY_TABS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="text-xl text-ink">
          Engine &amp; Pipeline Components
        </h2>
        <div className="text-xs text-ink-3 flex items-center gap-2">
          <span className="size-2 rounded-full bg-success" aria-hidden="true" />
          <span>Operational &amp; Ready</span>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Component categories"
        className="flex flex-wrap items-center gap-2"
      >
        {CATEGORY_TABS.map((tab, index) => {
          const isSelected = activeCategory === tab.id;
          return (
            <button
              key={tab.id}
              id={`status-tab-${tab.id}`}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls="status-components-tabpanel"
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelectCategory(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={`min-h-[44px] px-3.5 py-2 rounded-sm text-xs font-semibold border transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-surface text-ink-2 border-rule hover:border-accent hover:text-ink'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        id="status-components-tabpanel"
        role="tabpanel"
        aria-labelledby={activeTabId}
        className="grid grid-cols-1 md:grid-cols-2 gap-3"
      >
        {components.map((component) => (
          <div
            key={component.id}
            className="border-t border-rule-strong pt-5 flex flex-col justify-between"
          >
            <div>
              <div className="flex items-start justify-between gap-3 mb-1.5">
                <h3 className="text-sm font-bold text-ink">
                  {component.name}
                </h3>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-sm text-[11px] font-semibold bg-success/10 text-success border border-success-edge/20 shrink-0">
                  <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                  <span>Operational</span>
                </span>
              </div>
              <p className="text-xs text-ink-2 leading-relaxed">
                {component.description}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SandboxArchitectureCard() {
  return (
    <section className="border-t border-rule-strong pt-6 sm:pt-8 flex flex-col md:flex-row items-start gap-5">
      <div className="text-accent-ink shrink-0">
        <Cpu className="w-6 h-6" aria-hidden="true" />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg sm:text-xl text-ink">
          Local Browser Sandbox Execution
        </h2>
        <p className="text-xs sm:text-sm text-ink-2 leading-relaxed">
          Supported client-side codecs compile to WebAssembly and run inside an isolated browser
          worker sandbox. Local execution avoids upload wait times, keeps memory buffers ephemeral,
          and releases temporary storage handles as soon as conversion finishes.
        </p>
        <div className="flex flex-wrap gap-4 pt-2 text-xs font-semibold text-accent-ink">
          <span className="flex items-center gap-1.5">
            <Check className="w-4 h-4 text-success" aria-hidden="true" />
            <span>Zero-Retention Sandboxing</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Check className="w-4 h-4 text-success" aria-hidden="true" />
            <span>Hardware SIMD &amp; WebCodecs Support</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Check className="w-4 h-4 text-success" aria-hidden="true" />
            <span>Unlimited Free Conversions</span>
          </span>
        </div>
      </div>
    </section>
  );
}

function buildDiagnosticAnnouncement(
  isRunning: boolean,
  results: DiagnosticResult[] | null
): string {
  if (isRunning) return 'Running browser edge diagnostics...';
  if (!results) return '';
  const activeCount = results.filter((item) => item.supported).length;
  return `Edge diagnostics complete. ${activeCount} of ${results.length} capabilities active.`;
}

export default function StatusDashboard() {
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('all');
  const [checkedAtText, setCheckedAtText] = useState<string>(
    'Client telemetry active in browser sandbox'
  );
  const [isDiagnosticRunning, setIsDiagnosticRunning] = useState(false);
  const [diagnosticResults, setDiagnosticResults] = useState<DiagnosticResult[] | null>(null);
  const [detectedCores, setDetectedCores] = useState<number>(4);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
      setDetectedCores(navigator.hardwareConcurrency);
    }
    setCheckedAtText(`Client telemetry checked at ${new Date().toLocaleTimeString()}`);
  }, []);

  const filteredComponents = useMemo(() => {
    if (activeCategory === 'all') return ENGINE_COMPONENTS;
    return ENGINE_COMPONENTS.filter((c) => c.category === activeCategory);
  }, [activeCategory]);

  const runDiagnostics = async () => {
    setIsDiagnosticRunning(true);
    const results = collectEdgeDiagnostics();
    await new Promise((r) => setTimeout(r, 160));
    setDiagnosticResults(results);
    setIsDiagnosticRunning(false);
    setCheckedAtText(`Client telemetry checked at ${new Date().toLocaleTimeString()}`);
  };

  return (
    <div className="w-full space-y-8">
      <output aria-live="polite" className="sr-only">
        {buildDiagnosticAnnouncement(isDiagnosticRunning, diagnosticResults)}
      </output>

      <StatusOverviewCard
        isRunning={isDiagnosticRunning}
        checkedLabel={checkedAtText}
        onRunDiagnostics={() => {
          void runDiagnostics();
        }}
      />

      {diagnosticResults && <DiagnosticResultsCard results={diagnosticResults} />}

      <EnvironmentMetricsGrid detectedCores={detectedCores} />

      <ComponentStatusSection
        activeCategory={activeCategory}
        components={filteredComponents}
        onSelectCategory={setActiveCategory}
      />

      <SandboxArchitectureCard />
    </div>
  );
}
