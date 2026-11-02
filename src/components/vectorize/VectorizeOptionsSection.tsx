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
  setVectorizeFields,
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

interface NumberFieldProps {
  id: string;
  label: string;
  unit: string;
  /** The hint, or why the engine ignores the field when it is disabled. */
  help: string;
  /**
   * The whole numbers a field with a slider takes. A field without one takes any number above TOLERANCE_EXCLUSIVE_MINIMUM, and has no
   * value while it holds anything else.
   */
  range?: IntegerRange;
  placeholder?: string;
  value: number | undefined;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
}

/** The value a text sets as it is typed, or null when it sets none: a whole number in the range, or a tolerance above its minimum. */
function parseNumber(text: string, range: IntegerRange | undefined): number | null {
  const value = Number(text);
  if (range) return /^\d+$/.test(text) && value >= range.min && value <= range.max ? value : null;
  return text.trim() && Number.isFinite(value) && value > TOLERANCE_EXCLUSIVE_MINIMUM ? value : null;
}

/** The whole number in the range nearest to a typed number, or null for a text that is not a number. */
function clampNumber(text: string, range: IntegerRange): number | null {
  const value = Number(text);
  return text.trim() && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, Math.round(value))) : null;
}

/**
 * A number field with its unit inside, and a slider beside it when it has a range; the slider and the field move each other. What the
 * person typed is kept while it is not a value yet ("0" on the way to "0.5", an empty field on the way to "9") and until the value
 * changes some other way. Leaving the field brings a number past the range to the nearest whole number inside it, and shows the value.
 */
function NumberField({ id, label, unit, help, range, placeholder, value, disabled, onChange }: Readonly<NumberFieldProps>) {
  const t = useTranslations('options.vectorize');
  const [draft, setDraft] = useState<{ text: string; forValue: number | undefined } | null>(null);
  const shown = draft && draft.forValue === value ? draft.text : String(value ?? '');
  const fieldId = range ? `${id}-value` : id;
  const helpId = `${id}-help`;
  const type = (text: string) => {
    const parsed = parseNumber(text, range);
    const next = parsed ?? (range ? value : undefined);
    setDraft({ text, forValue: next });
    if (next !== value) onChange(next);
  };
  const leave = () => {
    const clamped = range && draft ? clampNumber(draft.text, range) : null;
    if (clamped !== null && clamped !== value) onChange(clamped);
    setDraft(null);
  };
  const field = (
    <div className="relative">
      <input
        id={fieldId}
        type="number"
        min={range?.min ?? TOLERANCE_EXCLUSIVE_MINIMUM}
        max={range?.max}
        step={range ? 1 : SIMPLIFY_STEP}
        value={shown}
        disabled={disabled}
        aria-label={t('fieldWithUnit', { field: label, unit })}
        aria-describedby={helpId}
        placeholder={placeholder}
        onChange={(e) => type(e.target.value)}
        onBlur={leave}
        className={`${INPUT_CLASS} pr-10 ${NO_SPIN_CLASS} ${DISABLED_CLASS}`}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs text-ink-3">{unit}</span>
    </div>
  );
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>{label}</label>
      {range ? (
        <div className="flex items-center gap-3">
          <input
            id={id}
            type="range"
            min={range.min}
            max={range.max}
            value={value}
            disabled={disabled}
            aria-describedby={helpId}
            onChange={(e) => onChange(Number(e.target.value))}
            className={`${RANGE_CLASS} min-w-0 flex-1 ${DISABLED_CLASS}`}
            style={rangeFill(value ?? range.min, range.min, range.max)}
          />
          <div className="w-28 shrink-0">{field}</div>
        </div>
      ) : (
        field
      )}
      <p id={helpId} className={HELP_CLASS}>{help}</p>
    </div>
  );
}

/** The range as the values a hint names it with. */
const limits = ({ min, max }: IntegerRange) => ({ min, max });

/** The fields under the Advanced disclosure. */
const ADVANCED_FIELDS = ['filterSpeckle', 'colorPrecision', 'simplify'] as const;

type PresetChoice = 'none' | (typeof VECTORIZE_PRESETS)[number];

/**
 * The tracer options of a raster to SVG pair: only the values a person changes are sent, so the preset decides the rest. A field the
 * engine ignores for the chosen preset or mode is greyed out with the reason.
 */
export function VectorizeOptionsSection({ options, onChange }: Readonly<SectionProps>) {
  const t = useTranslations('options.vectorize');
  const current = options.vectorize ?? {};
  const [advancedOpen, setAdvancedOpen] = useState(() => ADVANCED_FIELDS.some((key) => current[key] !== undefined));
  const advancedId = useId();
  const defaults = vectorizeDefaults(current.preset);
  // The values stay as typed while the engine ignores them, so switching back restores them; the queue item keeps only what it reads.
  const update = (patch: VectorizeOptions) => onChange({ ...options, vectorize: setVectorizeFields({ ...current, ...patch }) });
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
          onSelect={(preset) => update({ preset: preset === 'none' ? undefined : preset })}
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
        aria-controls={advancedOpen ? advancedId : undefined}
        onClick={() => setAdvancedOpen(!advancedOpen)}
        className="inline-flex items-center gap-1.5 min-h-[44px] rounded-xs text-sm font-medium text-ink-2 hover:text-ink cursor-pointer"
      >
        {t('advanced')}
        <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${advancedOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {advancedOpen && (
        <div id={advancedId} className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          <NumberField
            id="opt-vectorize-filter-speckle"
            label={t('filterSpeckle')}
            unit={t('unitPixels')}
            help={t('filterSpeckleHint', limits(FILTER_SPECKLE_RANGE))}
            range={FILTER_SPECKLE_RANGE}
            value={current.filterSpeckle ?? defaults.filterSpeckle}
            disabled={false}
            onChange={(filterSpeckle) => update({ filterSpeckle })}
          />
          <NumberField
            id="opt-vectorize-color-precision"
            label={t('colorPrecision')}
            unit={t('unitBits')}
            help={colorPrecisionApplies ? t('colorPrecisionHint', limits(COLOR_PRECISION_RANGE)) : t('colorPrecisionNotApplied')}
            range={COLOR_PRECISION_RANGE}
            value={current.colorPrecision ?? defaults.colorPrecision}
            disabled={!colorPrecisionApplies}
            onChange={(colorPrecision) => update({ colorPrecision })}
          />
          <NumberField
            id="opt-vectorize-simplify"
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
