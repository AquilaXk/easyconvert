'use client';

import React, { useState } from 'react';
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
  TOLERANCE_EXCLUSIVE_MINIMUM,
  vectorizeDefaults,
  vectorizeOptionApplies,
  VECTORIZE_MODES,
  VECTORIZE_PRESETS,
  type IntegerRange,
  type VectorizeOptions,
} from '@/lib/conversions/raster-vectorize-options';

const SIMPLIFY_STEP = 0.1;
const HELP_CLASS = 'mt-1.5 text-xs text-ink-3';

interface RangeFieldProps {
  id: string;
  label: string;
  /** The hint, or why the engine ignores the field when it is disabled. */
  help: string;
  range: IntegerRange;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

function RangeField({ id, label, help, range, value, disabled, onChange }: Readonly<RangeFieldProps>) {
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
        disabled={disabled}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${RANGE_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
        style={rangeFill(value, range.min, range.max)}
      />
      <p id={`${id}-help`} className={HELP_CLASS}>{help}</p>
    </div>
  );
}

function parseTolerance(raw: string): number | undefined {
  const value = Number(raw);
  return raw.trim() && Number.isFinite(value) && value > TOLERANCE_EXCLUSIVE_MINIMUM ? value : undefined;
}

interface ToleranceFieldProps {
  label: string;
  help: string;
  placeholder: string;
  value: number | undefined;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
}

/** The simplify tolerance. What the person typed is kept while it is not a tolerance yet ("0" on the way to "0.5"). */
function ToleranceField({ label, help, placeholder, value, disabled, onChange }: Readonly<ToleranceFieldProps>) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const shown = parseTolerance(draft) === value ? draft : String(value ?? '');
  return (
    <div>
      <label htmlFor="opt-vectorize-simplify" className={LABEL_CLASS}>{label}</label>
      <input
        id="opt-vectorize-simplify"
        type="number"
        min={TOLERANCE_EXCLUSIVE_MINIMUM}
        step={SIMPLIFY_STEP}
        value={shown}
        disabled={disabled}
        aria-describedby="opt-vectorize-simplify-help"
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(parseTolerance(e.target.value));
        }}
        placeholder={placeholder}
        className={`${INPUT_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
      />
      <p id="opt-vectorize-simplify-help" className={HELP_CLASS}>{help}</p>
    </div>
  );
}

/**
 * The tracer options of a raster to SVG pair: only the values a person changes are sent, so the preset decides the rest. A field the
 * engine ignores for the chosen preset or mode is greyed out with the reason.
 */
export function VectorizeOptionsSection({ options, onChange }: Readonly<SectionProps>) {
  const t = useTranslations('options.vectorize');
  const current = options.vectorize ?? {};
  const defaults = vectorizeDefaults(current.preset);
  const update = (patch: VectorizeOptions) => onChange({ ...options, vectorize: sanitizeVectorizeOptions({ ...current, ...patch }) });
  const colorPrecisionApplies = vectorizeOptionApplies('colorPrecision', current);
  const simplifyApplies = vectorizeOptionApplies('simplify', current);
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
        help={t('filterSpeckleHint')}
        range={FILTER_SPECKLE_RANGE}
        value={current.filterSpeckle ?? defaults.filterSpeckle}
        disabled={false}
        onChange={(filterSpeckle) => update({ filterSpeckle })}
      />
      <RangeField
        id="opt-vectorize-color-precision"
        label={t('colorPrecision')}
        help={colorPrecisionApplies ? t('colorPrecisionHint') : t('colorPrecisionNotApplied')}
        range={COLOR_PRECISION_RANGE}
        value={current.colorPrecision ?? defaults.colorPrecision}
        disabled={!colorPrecisionApplies}
        onChange={(colorPrecision) => update({ colorPrecision })}
      />
      <ToleranceField
        label={t('simplify')}
        help={simplifyApplies ? t('simplifyHint') : t('simplifyNotApplied')}
        placeholder={t('simplifyOff')}
        value={current.simplify}
        disabled={!simplifyApplies}
        onChange={(simplify) => update({ simplify })}
      />
    </section>
  );
}
