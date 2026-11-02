'use client';

import React, { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  INPUT_CLASS,
  LABEL_CLASS,
  RANGE_CLASS,
  rangeFill,
  SECTION_HEADING_CLASS,
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
const DISABLED_CLASS = 'disabled:opacity-50 disabled:cursor-not-allowed';
const NO_SPIN_CLASS = '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

interface Choice<T extends string> {
  value: T;
  label: string;
  description?: string;
}

interface ChoiceListProps<T extends string> {
  label: string;
  choices: ReadonlyArray<Choice<T>>;
  selected: T;
  onSelect: (value: T) => void;
}

/** Radio buttons of one name are one tab stop and the arrow keys move the choice within them, so the list needs no key handling. */
function ChoiceList<T extends string>({ label, choices, selected, onSelect }: Readonly<ChoiceListProps<T>>) {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div role="radiogroup" aria-labelledby={labelId}>
      <span id={labelId} className={LABEL_CLASS}>{label}</span>
      {choices.map((choice) => (
        <label key={choice.value} className="grid grid-cols-[auto_1fr] items-center gap-x-2 py-1 cursor-pointer">
          <input
            type="radio"
            name={id}
            value={choice.value}
            checked={choice.value === selected}
            aria-labelledby={`${id}-${choice.value}-label`}
            aria-describedby={choice.description ? `${id}-${choice.value}-description` : undefined}
            onChange={() => onSelect(choice.value)}
            className="h-4 w-4 accent-accent cursor-pointer"
          />
          <span id={`${id}-${choice.value}-label`} className="text-sm text-ink">{choice.label}</span>
          {choice.description && (
            <span id={`${id}-${choice.value}-description`} className="col-start-2 text-xs text-ink-3">{choice.description}</span>
          )}
        </label>
      ))}
    </div>
  );
}

/** What a typed text means: a value, or null while it is not one yet (the person is on the way to a value). */
type Parsed = { value: number | undefined } | null;

interface NumberFieldProps {
  id: string;
  label: string;
  unit: string;
  placeholder?: string;
  min: number;
  max?: number;
  step: number;
  value: number | undefined;
  disabled: boolean;
  describedBy: string;
  parse: (raw: string) => Parsed;
  onChange: (value: number | undefined) => void;
}

/**
 * A number field with its unit inside. What the person typed is kept while it is not a value yet ("0" on the way to "0.5", an empty field
 * on the way to "9") and until the value changes some other way, as the slider moves it; leaving the field shows the value again.
 */
function NumberField({ id, label, unit, placeholder, min, max, step, value, disabled, describedBy, parse, onChange }: Readonly<NumberFieldProps>) {
  const t = useTranslations('options.vectorize');
  const [draft, setDraft] = useState<{ text: string; forValue: number | undefined } | null>(null);
  const shown = draft && draft.forValue === value ? draft.text : String(value ?? '');
  return (
    <div className="relative">
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-label={t('fieldWithUnit', { field: label, unit })}
        aria-describedby={describedBy}
        placeholder={placeholder}
        onChange={(e) => {
          const parsed = parse(e.target.value);
          setDraft({ text: e.target.value, forValue: parsed ? parsed.value : value });
          if (parsed) onChange(parsed.value);
        }}
        onBlur={() => setDraft(null)}
        className={`${INPUT_CLASS} pr-10 ${NO_SPIN_CLASS} ${DISABLED_CLASS}`}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs text-ink-3">{unit}</span>
    </div>
  );
}

interface RangeFieldProps {
  id: string;
  label: string;
  unit: string;
  /** The hint, or why the engine ignores the field when it is disabled. */
  help: string;
  range: IntegerRange;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

/** The range as the values a hint names it with. */
const limits = ({ min, max }: IntegerRange) => ({ min, max });

function parseInRange(range: IntegerRange, raw: string): Parsed {
  const value = Number(raw);
  return /^\d+$/.test(raw) && value >= range.min && value <= range.max ? { value } : null;
}

/** A whole number in a range: a slider and a number field that move each other. */
function RangeField({ id, label, unit, help, range, value, disabled, onChange }: Readonly<RangeFieldProps>) {
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>{label}</label>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={range.min}
          max={range.max}
          value={value}
          disabled={disabled}
          aria-describedby={`${id}-help`}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`${RANGE_CLASS} min-w-0 flex-1 ${DISABLED_CLASS}`}
          style={rangeFill(value, range.min, range.max)}
        />
        <div className="w-28 shrink-0">
          <NumberField
            id={`${id}-value`}
            label={label}
            unit={unit}
            min={range.min}
            max={range.max}
            step={1}
            value={value}
            disabled={disabled}
            describedBy={`${id}-help`}
            parse={(raw) => parseInRange(range, raw)}
            onChange={(next) => next !== undefined && onChange(next)}
          />
        </div>
      </div>
      <p id={`${id}-help`} className={HELP_CLASS}>{help}</p>
    </div>
  );
}

function parseTolerance(raw: string): Parsed {
  const value = Number(raw);
  return { value: raw.trim() && Number.isFinite(value) && value > TOLERANCE_EXCLUSIVE_MINIMUM ? value : undefined };
}

interface ToleranceFieldProps {
  label: string;
  unit: string;
  help: string;
  placeholder: string;
  value: number | undefined;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
}

/** The simplify tolerance: any number above 0, and an empty field or a value that is not one means no simplification. */
function ToleranceField({ label, unit, help, placeholder, value, disabled, onChange }: Readonly<ToleranceFieldProps>) {
  return (
    <div>
      <label htmlFor="opt-vectorize-simplify" className={LABEL_CLASS}>{label}</label>
      <NumberField
        id="opt-vectorize-simplify"
        label={label}
        unit={unit}
        placeholder={placeholder}
        min={TOLERANCE_EXCLUSIVE_MINIMUM}
        step={SIMPLIFY_STEP}
        value={value}
        disabled={disabled}
        describedBy="opt-vectorize-simplify-help"
        parse={parseTolerance}
        onChange={onChange}
      />
      <p id="opt-vectorize-simplify-help" className={HELP_CLASS}>{help}</p>
    </div>
  );
}

type PresetChoice = 'none' | (typeof VECTORIZE_PRESETS)[number];

/**
 * The tracer options of a raster to SVG pair: only the values a person changes are sent, so the preset decides the rest. A field the
 * engine ignores for the chosen preset or mode is greyed out with the reason.
 */
export function VectorizeOptionsSection({ options, onChange }: Readonly<SectionProps>) {
  const t = useTranslations('options.vectorize');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedId = useId();
  const current = options.vectorize ?? {};
  const defaults = vectorizeDefaults(current.preset);
  const update = (patch: VectorizeOptions) => onChange({ ...options, vectorize: sanitizeVectorizeOptions({ ...current, ...patch }) });
  const colorPrecisionApplies = vectorizeOptionApplies('colorPrecision', current);
  const simplifyApplies = vectorizeOptionApplies('simplify', current);
  const presetChoices: ReadonlyArray<Choice<PresetChoice>> = [
    { value: 'none', label: t('presetChoices.none') },
    ...VECTORIZE_PRESETS.map((preset) => ({ value: preset, label: t(`presetChoices.${preset}`), description: t(`presetDescriptions.${preset}`) })),
  ];
  const modeChoices = VECTORIZE_MODES.map((mode) => ({ value: mode, label: t(`modeChoices.${mode}`), description: t(`modeDescriptions.${mode}`) }));
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>{t('heading')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
        <ChoiceList
          label={t('preset')}
          choices={presetChoices}
          selected={current.preset ?? 'none'}
          onSelect={(preset) => update({ preset: VECTORIZE_PRESETS.find((candidate) => candidate === preset) })}
        />
        <ChoiceList
          label={t('mode')}
          choices={modeChoices}
          selected={current.mode ?? DEFAULT_VECTORIZE_MODE}
          onSelect={(mode) => update({ mode })}
        />
      </div>
      <button
        type="button"
        aria-expanded={advancedOpen}
        aria-controls={advancedId}
        onClick={() => setAdvancedOpen(!advancedOpen)}
        className="inline-flex items-center gap-1.5 min-h-[44px] rounded-xs text-sm font-medium text-ink-2 hover:text-ink cursor-pointer"
      >
        {t('advanced')}
        <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${advancedOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {advancedOpen && (
        <div id={advancedId} className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          <RangeField
            id="opt-vectorize-filter-speckle"
            label={t('filterSpeckle')}
            unit={t('unitPixels')}
            help={t('filterSpeckleHint', limits(FILTER_SPECKLE_RANGE))}
            range={FILTER_SPECKLE_RANGE}
            value={current.filterSpeckle ?? defaults.filterSpeckle}
            disabled={false}
            onChange={(filterSpeckle) => update({ filterSpeckle })}
          />
          <RangeField
            id="opt-vectorize-color-precision"
            label={t('colorPrecision')}
            unit={t('unitBits')}
            help={colorPrecisionApplies ? t('colorPrecisionHint', limits(COLOR_PRECISION_RANGE)) : t('colorPrecisionNotApplied')}
            range={COLOR_PRECISION_RANGE}
            value={current.colorPrecision ?? defaults.colorPrecision}
            disabled={!colorPrecisionApplies}
            onChange={(colorPrecision) => update({ colorPrecision })}
          />
          <ToleranceField
            label={t('simplify')}
            unit={t('unitPixels')}
            help={simplifyApplies ? t('simplifyHint') : t('simplifyNotApplied')}
            placeholder={t('simplifyOff')}
            value={current.simplify}
            disabled={!simplifyApplies}
            onChange={(simplify) => update({ simplify })}
          />
        </div>
      )}
    </section>
  );
}
