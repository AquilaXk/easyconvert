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
  DEFAULT_VECTORIZE_HIERARCHICAL,
  DEFAULT_VECTORIZE_MODE,
  FILTER_SPECKLE_RANGE,
  GRADIENT_STEP_RANGE,
  MAX_COLORS_RANGE,
  PATH_PRECISION_RANGE,
  pickVectorizeFields,
  TOLERANCE_EXCLUSIVE_MINIMUM,
  vectorizeDefaults,
  vectorizeOptionApplies,
  VECTORIZE_HIERARCHICALS,
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

/** The words around a field: its label and unit, the hint (or why the engine ignores the field), and whether it is ignored. */
interface FieldText {
  id: string;
  label: string;
  unit: string;
  help: string;
  disabled: boolean;
}

interface NumberInputProps {
  id: string;
  label: string;
  unit: string;
  helpId: string;
  placeholder?: string;
  disabled: boolean;
  min: number;
  max?: number;
  step: number;
  value: number | undefined;
  typedValue: (text: string) => number | undefined;
  settle?: (text: string) => number | null;
  onChange: (value: number | undefined) => void;
}

/**
 * A number field with its unit inside. What the person typed is kept while it is not a value yet ("0" on the way to "0.5", an empty
 * field on the way to "9") and until the value changes some other way; leaving the field shows the value.
 */
function NumberInput({ id, label, unit, helpId, placeholder, disabled, min, max, step, value, typedValue, settle, onChange }: Readonly<NumberInputProps>) {
  const t = useTranslations('options.vectorize');
  const [draft, setDraft] = useState<{ text: string; forValue: number | undefined } | null>(null);
  const shown = draft && draft.forValue === value ? draft.text : String(value ?? '');
  const type = (text: string) => {
    const next = typedValue(text);
    setDraft({ text, forValue: next });
    if (next !== value) onChange(next);
  };
  const leave = () => {
    const settled = draft && settle ? settle(draft.text) : null;
    if (settled !== null && settled !== value) onChange(settled);
    setDraft(null);
  };
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
        aria-describedby={helpId}
        placeholder={placeholder}
        onChange={(e) => type(e.target.value)}
        onBlur={leave}
        className={`${INPUT_CLASS} pr-12 ${NO_SPIN_CLASS} ${DISABLED_CLASS}`}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs text-ink-3">{unit}</span>
    </div>
  );
}

function parseInteger(text: string, range: IntegerRange): number | null {
  const value = Number(text);
  return /^\d+$/.test(text) && value >= range.min && value <= range.max ? value : null;
}

function clampNumber(text: string, range: IntegerRange): number | null {
  const value = Number(text);
  return text.trim() && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, Math.round(value))) : null;
}

function parseTolerance(text: string): number | null {
  const value = Number(text);
  return text.trim() && Number.isFinite(value) && value > TOLERANCE_EXCLUSIVE_MINIMUM ? value : null;
}

interface RangeFieldProps {
  text: FieldText;
  range: IntegerRange;
  value: number;
  onChange: (value: number) => void;
}

function RangeField({ text, range, value, onChange }: Readonly<RangeFieldProps>) {
  const helpId = `${text.id}-help`;
  return (
    <div>
      <label htmlFor={text.id} className={LABEL_CLASS}>{text.label}</label>
      <div className="flex items-center gap-3">
        <input
          id={text.id}
          type="range"
          min={range.min}
          max={range.max}
          value={value}
          disabled={text.disabled}
          aria-describedby={helpId}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`${RANGE_CLASS} min-w-0 flex-1 ${DISABLED_CLASS}`}
          style={rangeFill(value, range.min, range.max)}
        />
        <div className="w-28 shrink-0">
          <NumberInput
            id={`${text.id}-value`}
            label={text.label}
            unit={text.unit}
            helpId={helpId}
            disabled={text.disabled}
            min={range.min}
            max={range.max}
            step={1}
            value={value}
            typedValue={(typed) => parseInteger(typed, range) ?? value}
            settle={(typed) => clampNumber(typed, range)}
            onChange={(next) => onChange(next ?? value)}
          />
        </div>
      </div>
      <p id={helpId} className={HELP_CLASS}>{text.help}</p>
    </div>
  );
}

interface OptionalIntegerFieldProps {
  text: FieldText;
  range: IntegerRange;
  placeholder: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}

function OptionalIntegerField({ text, range, placeholder, value, onChange }: Readonly<OptionalIntegerFieldProps>) {
  const helpId = `${text.id}-help`;
  return (
    <div>
      <label htmlFor={text.id} className={LABEL_CLASS}>{text.label}</label>
      <NumberInput
        id={text.id}
        label={text.label}
        unit={text.unit}
        helpId={helpId}
        placeholder={placeholder}
        disabled={text.disabled}
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        typedValue={(typed) => (typed.trim() === '' ? undefined : (parseInteger(typed, range) ?? value))}
        settle={(typed) => (typed.trim() === '' ? null : clampNumber(typed, range))}
        onChange={onChange}
      />
      <p id={helpId} className={HELP_CLASS}>{text.help}</p>
    </div>
  );
}

interface ToleranceFieldProps {
  text: FieldText;
  placeholder: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}

function ToleranceField({ text, placeholder, value, onChange }: Readonly<ToleranceFieldProps>) {
  const helpId = `${text.id}-help`;
  return (
    <div>
      <label htmlFor={text.id} className={LABEL_CLASS}>{text.label}</label>
      <NumberInput
        id={text.id}
        label={text.label}
        unit={text.unit}
        helpId={helpId}
        placeholder={placeholder}
        disabled={text.disabled}
        min={TOLERANCE_EXCLUSIVE_MINIMUM}
        step={SIMPLIFY_STEP}
        value={value}
        typedValue={(typed) => parseTolerance(typed) ?? undefined}
        onChange={onChange}
      />
      <p id={helpId} className={HELP_CLASS}>{text.help}</p>
    </div>
  );
}

interface ToggleFieldProps {
  id: string;
  label: string;
  help: string;
  disabled: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleField({ id, label, help, disabled, checked, onChange }: Readonly<ToggleFieldProps>) {
  const helpId = `${id}-help`;
  return (
    <div className="sm:col-span-2">
      <label htmlFor={id} className={`inline-flex items-center gap-2.5 cursor-pointer ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={helpId}
          onChange={(e) => onChange(e.target.checked)}
          className={`h-4 w-4 rounded accent-accent cursor-pointer ${DISABLED_CLASS}`}
        />
        <span className="text-sm font-medium text-ink">{label}</span>
      </label>
      <p id={helpId} className={HELP_CLASS}>{help}</p>
    </div>
  );
}

const limits = ({ min, max }: IntegerRange) => ({ min, max });

const ADVANCED_KEYS = [
  'filterSpeckle',
  'colorPrecision',
  'gradientStep',
  'maxColors',
  'simplify',
  'pathPrecision',
  'adaptive',
] as const;

type PresetChoice = 'none' | (typeof VECTORIZE_PRESETS)[number];

/**
 * The tracer options of a raster to SVG pair: only the values a person changes are sent, so the preset decides the rest. A field the
 * engine ignores for the chosen preset or mode is greyed out with the reason while retaining typed values across mode switches.
 */
export function VectorizeOptionsSection({ options, onChange }: Readonly<SectionProps>) {
  const t = useTranslations('options.vectorize');
  const current = options.vectorize ?? {};
  const [advancedOpen, setAdvancedOpen] = useState(() => ADVANCED_KEYS.some((key) => current[key] !== undefined));
  const advancedId = useId();
  const defaults = vectorizeDefaults(current.preset);

  const update = (patch: VectorizeOptions) => onChange({ ...options, vectorize: pickVectorizeFields({ ...current, ...patch }) });

  const presetChoices: ReadonlyArray<Choice<PresetChoice>> = [
    { value: 'none', label: t('presetChoices.none') },
    ...VECTORIZE_PRESETS.map((preset) => ({ value: preset, label: t(`presetChoices.${preset}`), description: t(`presetDescriptions.${preset}`) })),
  ];
  const modeChoices = VECTORIZE_MODES.map((mode) => ({ value: mode, label: t(`modeChoices.${mode}`), description: t(`modeDescriptions.${mode}`) }));
  const hierarchicalChoices = VECTORIZE_HIERARCHICALS.map((h) => ({
    value: h,
    label: t(`hierarchicalChoices.${h}`),
    description: t(`hierarchicalDescriptions.${h}`),
  }));

  const makeText = (
    key: 'filterSpeckle' | 'colorPrecision' | 'gradientStep' | 'maxColors' | 'simplify' | 'pathPrecision',
    id: string,
    unitKey: 'unitPixels' | 'unitBits' | 'unitStep' | 'unitColors' | 'unitDecimals',
    hint: string,
    ignored?: string
  ): FieldText => {
    const applies = vectorizeOptionApplies(key, current);
    return { id, label: t(key), unit: t(unitKey), help: applies ? hint : (ignored ?? hint), disabled: !applies };
  };

  const adaptiveApplies = vectorizeOptionApplies('adaptive', current);

  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>{t('heading')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-4">
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
        <ChoiceList
          label={t('hierarchical')}
          choices={hierarchicalChoices}
          selected={current.hierarchical ?? DEFAULT_VECTORIZE_HIERARCHICAL}
          onSelect={(hierarchical) => update({ hierarchical })}
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
          <RangeField
            text={makeText('filterSpeckle', 'opt-vectorize-filter-speckle', 'unitPixels', t('filterSpeckleHint', limits(FILTER_SPECKLE_RANGE)))}
            range={FILTER_SPECKLE_RANGE}
            value={current.filterSpeckle ?? defaults.filterSpeckle}
            onChange={(filterSpeckle) => update({ filterSpeckle })}
          />
          <RangeField
            text={makeText(
              'colorPrecision',
              'opt-vectorize-color-precision',
              'unitBits',
              t('colorPrecisionHint', limits(COLOR_PRECISION_RANGE)),
              t('colorPrecisionNotApplied')
            )}
            range={COLOR_PRECISION_RANGE}
            value={current.colorPrecision ?? defaults.colorPrecision}
            onChange={(colorPrecision) => update({ colorPrecision })}
          />
          <RangeField
            text={makeText(
              'gradientStep',
              'opt-vectorize-gradient-step',
              'unitStep',
              t('gradientStepHint', limits(GRADIENT_STEP_RANGE)),
              t('gradientStepNotApplied')
            )}
            range={GRADIENT_STEP_RANGE}
            value={current.gradientStep ?? defaults.gradientStep}
            onChange={(gradientStep) => update({ gradientStep })}
          />
          <OptionalIntegerField
            text={makeText(
              'maxColors',
              'opt-vectorize-max-colors',
              'unitColors',
              t('maxColorsHint', limits(MAX_COLORS_RANGE)),
              t('maxColorsNotApplied')
            )}
            range={MAX_COLORS_RANGE}
            placeholder={t('maxColorsOff')}
            value={current.maxColors}
            onChange={(maxColors) => update({ maxColors })}
          />
          <ToleranceField
            text={makeText('simplify', 'opt-vectorize-simplify', 'unitPixels', t('simplifyHint'), t('simplifyNotApplied'))}
            placeholder={t('simplifyOff')}
            value={current.simplify}
            onChange={(simplify) => update({ simplify })}
          />
          <RangeField
            text={makeText('pathPrecision', 'opt-vectorize-path-precision', 'unitDecimals', t('pathPrecisionHint', limits(PATH_PRECISION_RANGE)))}
            range={PATH_PRECISION_RANGE}
            value={current.pathPrecision ?? defaults.pathPrecision}
            onChange={(pathPrecision) => update({ pathPrecision })}
          />
          <ToggleField
            id="opt-vectorize-adaptive"
            label={t('adaptive')}
            help={adaptiveApplies ? t('adaptiveHint') : t('adaptiveNotApplied')}
            disabled={!adaptiveApplies}
            checked={current.adaptive === true}
            onChange={(checked) => update({ adaptive: checked ? true : undefined })}
          />
        </div>
      )}
    </section>
  );
}
