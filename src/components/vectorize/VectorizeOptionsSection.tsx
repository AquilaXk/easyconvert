'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import {
  INPUT_CLASS,
  LABEL_CLASS,
  RANGE_CLASS,
  rangeFill,
  SECTION_HEADING_CLASS,
  SELECT_CLASS,
  type SectionProps,
} from '@/components/workbench/options/section-primitives';
import {
  COLOR_PRECISION_RANGE,
  DEFAULT_VECTORIZE_MODE,
  FILTER_SPECKLE_RANGE,
  sanitizeVectorizeOptions,
  vectorizeDefaults,
  VECTORIZE_MODES,
  VECTORIZE_PRESETS,
  type IntegerRange,
  type VectorizeOptions,
} from '@/lib/conversions/raster-vectorize-options';

const SIMPLIFY_STEP = 0.1;

interface RangeFieldProps {
  id: string;
  label: string;
  hint: string;
  range: IntegerRange;
  value: number;
  onChange: (value: number) => void;
}

function RangeField({ id, label, hint, range, value, onChange }: Readonly<RangeFieldProps>) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label htmlFor={id} className="text-xs font-semibold text-ink">{label}</label>
        <span className="text-xs font-mono text-accent-ink">{value}</span>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        value={value}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(Number(e.target.value))}
        className={RANGE_CLASS}
        style={rangeFill(value, range.min, range.max)}
      />
      <p id={`${id}-help`} className="mt-1.5 text-xs text-ink-3">{hint}</p>
    </div>
  );
}

function parseTolerance(raw: string): number | undefined {
  const value = Number(raw);
  return raw.trim() && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The tracer options of a raster to SVG pair: only the values a person changes are sent, so the preset decides the rest. */
export function VectorizeOptionsSection({ options, onChange }: Readonly<SectionProps>) {
  const t = useTranslations('options.vectorize');
  const current = options.vectorize ?? {};
  const defaults = vectorizeDefaults(current.preset);
  const update = (patch: VectorizeOptions) => onChange({ ...options, vectorize: sanitizeVectorizeOptions({ ...current, ...patch }) });
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>{t('heading')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="opt-vectorize-preset" className={LABEL_CLASS}>{t('preset')}</label>
          <select
            id="opt-vectorize-preset"
            value={current.preset ?? ''}
            onChange={(e) => update({ preset: VECTORIZE_PRESETS.find((preset) => preset === e.target.value) })}
            className={SELECT_CLASS}
          >
            <option value="">{t('presetNone')}</option>
            {VECTORIZE_PRESETS.map((preset) => <option key={preset} value={preset}>{t(`presetChoices.${preset}`)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="opt-vectorize-mode" className={LABEL_CLASS}>{t('mode')}</label>
          <select
            id="opt-vectorize-mode"
            value={current.mode ?? DEFAULT_VECTORIZE_MODE}
            onChange={(e) => update({ mode: VECTORIZE_MODES.find((mode) => mode === e.target.value) })}
            className={SELECT_CLASS}
          >
            {VECTORIZE_MODES.map((mode) => <option key={mode} value={mode}>{t(`modeChoices.${mode}`)}</option>)}
          </select>
        </div>
      </div>
      <RangeField
        id="opt-vectorize-filter-speckle"
        label={t('filterSpeckle')}
        hint={t('filterSpeckleHint')}
        range={FILTER_SPECKLE_RANGE}
        value={current.filterSpeckle ?? defaults.filterSpeckle}
        onChange={(filterSpeckle) => update({ filterSpeckle })}
      />
      <RangeField
        id="opt-vectorize-color-precision"
        label={t('colorPrecision')}
        hint={t('colorPrecisionHint')}
        range={COLOR_PRECISION_RANGE}
        value={current.colorPrecision ?? defaults.colorPrecision}
        onChange={(colorPrecision) => update({ colorPrecision })}
      />
      <div>
        <label htmlFor="opt-vectorize-simplify" className={LABEL_CLASS}>{t('simplify')}</label>
        <input
          id="opt-vectorize-simplify"
          type="number"
          min={SIMPLIFY_STEP}
          step={SIMPLIFY_STEP}
          value={current.simplify ?? ''}
          aria-describedby="opt-vectorize-simplify-help"
          onChange={(e) => update({ simplify: parseTolerance(e.target.value) })}
          placeholder={t('simplifyOff')}
          className={INPUT_CLASS}
        />
        <p id="opt-vectorize-simplify-help" className="mt-1.5 text-xs text-ink-3">{t('simplifyHint')}</p>
      </div>
    </section>
  );
}
