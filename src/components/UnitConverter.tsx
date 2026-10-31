'use client';

import React, { useState, useMemo } from 'react';
import {
  Copy,
  Check,
  ArrowRightLeft,
  Ruler,
  Scale,
  Thermometer,
  Maximize2,
  Box,
  Gauge,
  Clock,
  HardDrive,
  Compass,
  Zap,
  HelpCircle,
  TrendingUp,
} from 'lucide-react';

export interface UnitDefinition {
  id: string;
  name: string;
  symbol: string;
  toBase: number | ((val: number) => number);
  fromBase: number | ((baseVal: number) => number);
}

export interface UnitCategory {
  id: string;
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultFrom: string;
  defaultTo: string;
  baseUnit: string;
  units: Record<string, UnitDefinition>;
  formulaDescription?: (from: string, to: string, val: number, res: number) => string;
}

export const UNIT_CATEGORIES: Record<string, UnitCategory> = {
  weight: {
    id: 'weight',
    name: 'Weight & Mass',
    icon: Scale,
    defaultFrom: 'lbs',
    defaultTo: 'kg',
    baseUnit: 'g',
    units: {
      kg: { id: 'kg', name: 'Kilograms', symbol: 'kg', toBase: 1000, fromBase: 0.001 },
      g: { id: 'g', name: 'Grams', symbol: 'g', toBase: 1, fromBase: 1 },
      mg: { id: 'mg', name: 'Milligrams', symbol: 'mg', toBase: 0.001, fromBase: 1000 },
      mcg: { id: 'mcg', name: 'Micrograms', symbol: 'µg', toBase: 0.000001, fromBase: 1000000 },
      lbs: { id: 'lbs', name: 'Pounds', symbol: 'lbs', toBase: 453.59237, fromBase: 1 / 453.59237 },
      oz: { id: 'oz', name: 'Ounces', symbol: 'oz', toBase: 28.349523125, fromBase: 1 / 28.349523125 },
      stone: { id: 'stone', name: 'Stones', symbol: 'st', toBase: 6350.29318, fromBase: 1 / 6350.29318 },
      ton: { id: 'ton', name: 'Metric Tons', symbol: 't', toBase: 1000000, fromBase: 0.000001 },
      carat: { id: 'carat', name: 'Carats', symbol: 'ct', toBase: 0.2, fromBase: 5 },
    },
  },
  length: {
    id: 'length',
    name: 'Length',
    icon: Ruler,
    defaultFrom: 'meters',
    defaultTo: 'feet',
    baseUnit: 'm',
    units: {
      meters: { id: 'meters', name: 'Meters', symbol: 'm', toBase: 1, fromBase: 1 },
      km: { id: 'km', name: 'Kilometers', symbol: 'km', toBase: 1000, fromBase: 0.001 },
      cm: { id: 'cm', name: 'Centimeters', symbol: 'cm', toBase: 0.01, fromBase: 100 },
      mm: { id: 'mm', name: 'Millimeters', symbol: 'mm', toBase: 0.001, fromBase: 1000 },
      um: { id: 'um', name: 'Micrometers', symbol: 'µm', toBase: 0.000001, fromBase: 1000000 },
      feet: { id: 'feet', name: 'Feet', symbol: 'ft', toBase: 0.3048, fromBase: 1 / 0.3048 },
      inches: { id: 'inches', name: 'Inches', symbol: 'in', toBase: 0.0254, fromBase: 1 / 0.0254 },
      yards: { id: 'yards', name: 'Yards', symbol: 'yd', toBase: 0.9144, fromBase: 1 / 0.9144 },
      miles: { id: 'miles', name: 'Miles', symbol: 'mi', toBase: 1609.344, fromBase: 1 / 1609.344 },
      nautical: { id: 'nautical', name: 'Nautical Miles', symbol: 'NM', toBase: 1852, fromBase: 1 / 1852 },
    },
  },
  temperature: {
    id: 'temperature',
    name: 'Temperature',
    icon: Thermometer,
    defaultFrom: 'celsius',
    defaultTo: 'fahrenheit',
    baseUnit: 'celsius',
    units: {
      celsius: {
        id: 'celsius',
        name: 'Celsius',
        symbol: '°C',
        toBase: (v) => v,
        fromBase: (v) => v,
      },
      fahrenheit: {
        id: 'fahrenheit',
        name: 'Fahrenheit',
        symbol: '°F',
        toBase: (v) => ((v - 32) * 5) / 9,
        fromBase: (v) => (v * 9) / 5 + 32,
      },
      kelvin: {
        id: 'kelvin',
        name: 'Kelvin',
        symbol: 'K',
        toBase: (v) => v - 273.15,
        fromBase: (v) => v + 273.15,
      },
      rankine: {
        id: 'rankine',
        name: 'Rankine',
        symbol: '°R',
        toBase: (v) => ((v - 491.67) * 5) / 9,
        fromBase: (v) => (v * 9) / 5 + 491.67,
      },
    },
    formulaDescription: (from, to, val, res) => {
      if (from === 'celsius' && to === 'fahrenheit') return `(${val}°C × 9/5) + 32 = ${res.toFixed(2)}°F`;
      if (from === 'fahrenheit' && to === 'celsius') return `(${val}°F - 32) × 5/9 = ${res.toFixed(2)}°C`;
      if (from === 'celsius' && to === 'kelvin') return `${val}°C + 273.15 = ${res.toFixed(2)} K`;
      if (from === 'kelvin' && to === 'celsius') return `${val} K - 273.15 = ${res.toFixed(2)}°C`;
      if (from === 'fahrenheit' && to === 'kelvin') return `(${val}°F - 32) × 5/9 + 273.15 = ${res.toFixed(2)} K`;
      if (from === 'kelvin' && to === 'fahrenheit') return `(${val} K - 273.15) × 9/5 + 32 = ${res.toFixed(2)}°F`;
      return `${val} ${from} = ${res} ${to}`;
    },
  },
  area: {
    id: 'area',
    name: 'Area',
    icon: Maximize2,
    defaultFrom: 'sqm',
    defaultTo: 'sqft',
    baseUnit: 'sqm',
    units: {
      sqm: { id: 'sqm', name: 'Square Meters', symbol: 'm²', toBase: 1, fromBase: 1 },
      sqkm: { id: 'sqkm', name: 'Square Kilometers', symbol: 'km²', toBase: 1000000, fromBase: 0.000001 },
      sqft: { id: 'sqft', name: 'Square Feet', symbol: 'ft²', toBase: 0.09290304, fromBase: 1 / 0.09290304 },
      sqyd: { id: 'sqyd', name: 'Square Yards', symbol: 'yd²', toBase: 0.83612736, fromBase: 1 / 0.83612736 },
      acres: { id: 'acres', name: 'Acres', symbol: 'ac', toBase: 4046.8564224, fromBase: 1 / 4046.8564224 },
      hectares: { id: 'hectares', name: 'Hectares', symbol: 'ha', toBase: 10000, fromBase: 0.0001 },
      sqmi: { id: 'sqmi', name: 'Square Miles', symbol: 'mi²', toBase: 2589988.110336, fromBase: 1 / 2589988.110336 },
    },
  },
  volume: {
    id: 'volume',
    name: 'Volume',
    icon: Box,
    defaultFrom: 'liters',
    defaultTo: 'gallons',
    baseUnit: 'liters',
    units: {
      liters: { id: 'liters', name: 'Liters', symbol: 'L', toBase: 1, fromBase: 1 },
      ml: { id: 'ml', name: 'Milliliters', symbol: 'mL', toBase: 0.001, fromBase: 1000 },
      cubm: { id: 'cubm', name: 'Cubic Meters', symbol: 'm³', toBase: 1000, fromBase: 0.001 },
      gallons: { id: 'gallons', name: 'US Gallons', symbol: 'gal', toBase: 3.785411784, fromBase: 1 / 3.785411784 },
      impgal: { id: 'impgal', name: 'Imperial Gallons', symbol: 'imp gal', toBase: 4.54609, fromBase: 1 / 4.54609 },
      quarts: { id: 'quarts', name: 'US Quarts', symbol: 'qt', toBase: 0.946352946, fromBase: 1 / 0.946352946 },
      pints: { id: 'pints', name: 'US Pints', symbol: 'pt', toBase: 0.473176473, fromBase: 1 / 0.473176473 },
      floz: { id: 'floz', name: 'US Fluid Ounces', symbol: 'fl oz', toBase: 0.0295735295625, fromBase: 1 / 0.0295735295625 },
      cups: { id: 'cups', name: 'US Cups', symbol: 'cup', toBase: 0.24, fromBase: 1 / 0.24 },
      tbsp: { id: 'tbsp', name: 'Tablespoons', symbol: 'tbsp', toBase: 0.0147868, fromBase: 1 / 0.0147868 },
      tsp: { id: 'tsp', name: 'Teaspoons', symbol: 'tsp', toBase: 0.00492892, fromBase: 1 / 0.00492892 },
    },
  },
  speed: {
    id: 'speed',
    name: 'Speed',
    icon: Gauge,
    defaultFrom: 'kmh',
    defaultTo: 'mph',
    baseUnit: 'ms',
    units: {
      kmh: { id: 'kmh', name: 'Kilometers per hour', symbol: 'km/h', toBase: 1 / 3.6, fromBase: 3.6 },
      mph: { id: 'mph', name: 'Miles per hour', symbol: 'mph', toBase: 0.44704, fromBase: 1 / 0.44704 },
      ms: { id: 'ms', name: 'Meters per second', symbol: 'm/s', toBase: 1, fromBase: 1 },
      knots: { id: 'knots', name: 'Knots', symbol: 'kn', toBase: 1852 / 3600, fromBase: 3600 / 1852 },
      fts: { id: 'fts', name: 'Feet per second', symbol: 'ft/s', toBase: 0.3048, fromBase: 1 / 0.3048 },
      mach: { id: 'mach', name: 'Mach (Speed of Sound)', symbol: 'Ma', toBase: 343, fromBase: 1 / 343 },
    },
  },
  digital: {
    id: 'digital',
    name: 'Digital Storage',
    icon: HardDrive,
    defaultFrom: 'mb',
    defaultTo: 'gb',
    baseUnit: 'bytes',
    units: {
      bytes: { id: 'bytes', name: 'Bytes', symbol: 'B', toBase: 1, fromBase: 1 },
      kb: { id: 'kb', name: 'Kilobytes (Decimal)', symbol: 'KB', toBase: 1000, fromBase: 0.001 },
      mb: { id: 'mb', name: 'Megabytes (Decimal)', symbol: 'MB', toBase: 1000000, fromBase: 0.000001 },
      gb: { id: 'gb', name: 'Gigabytes (Decimal)', symbol: 'GB', toBase: 1000000000, fromBase: 0.000000001 },
      tb: { id: 'tb', name: 'Terabytes (Decimal)', symbol: 'TB', toBase: 1000000000000, fromBase: 0.000000000001 },
      pb: { id: 'pb', name: 'Petabytes (Decimal)', symbol: 'PB', toBase: 1e15, fromBase: 1e-15 },
      kib: { id: 'kib', name: 'Kibibytes (Binary)', symbol: 'KiB', toBase: 1024, fromBase: 1 / 1024 },
      mib: { id: 'mib', name: 'Mebibytes (Binary)', symbol: 'MiB', toBase: 1048576, fromBase: 1 / 1048576 },
      gib: { id: 'gib', name: 'Gibibytes (Binary)', symbol: 'GiB', toBase: 1073741824, fromBase: 1 / 1073741824 },
      tib: { id: 'tib', name: 'Tebibytes (Binary)', symbol: 'TiB', toBase: 1099511627776, fromBase: 1 / 1099511627776 },
    },
  },
  time: {
    id: 'time',
    name: 'Time',
    icon: Clock,
    defaultFrom: 'hours',
    defaultTo: 'minutes',
    baseUnit: 'seconds',
    units: {
      seconds: { id: 'seconds', name: 'Seconds', symbol: 's', toBase: 1, fromBase: 1 },
      minutes: { id: 'minutes', name: 'Minutes', symbol: 'min', toBase: 60, fromBase: 1 / 60 },
      hours: { id: 'hours', name: 'Hours', symbol: 'h', toBase: 3600, fromBase: 1 / 3600 },
      days: { id: 'days', name: 'Days', symbol: 'd', toBase: 86400, fromBase: 1 / 86400 },
      weeks: { id: 'weeks', name: 'Weeks', symbol: 'wk', toBase: 604800, fromBase: 1 / 604800 },
      months: { id: 'months', name: 'Months (30.44d avg)', symbol: 'mo', toBase: 2629746, fromBase: 1 / 2629746 },
      years: { id: 'years', name: 'Years (365.25d)', symbol: 'yr', toBase: 31557600, fromBase: 1 / 31557600 },
    },
  },
  pressure: {
    id: 'pressure',
    name: 'Pressure',
    icon: Compass,
    defaultFrom: 'bar',
    defaultTo: 'psi',
    baseUnit: 'pascal',
    units: {
      pascal: { id: 'pascal', name: 'Pascals', symbol: 'Pa', toBase: 1, fromBase: 1 },
      kpa: { id: 'kpa', name: 'Kilopascals', symbol: 'kPa', toBase: 1000, fromBase: 0.001 },
      bar: { id: 'bar', name: 'Bar', symbol: 'bar', toBase: 100000, fromBase: 0.00001 },
      psi: { id: 'psi', name: 'Pounds per sq inch', symbol: 'psi', toBase: 6894.757293, fromBase: 1 / 6894.757293 },
      atm: { id: 'atm', name: 'Standard Atmospheres', symbol: 'atm', toBase: 101325, fromBase: 1 / 101325 },
      torr: { id: 'torr', name: 'Torr (mmHg)', symbol: 'torr', toBase: 133.322368, fromBase: 1 / 133.322368 },
    },
  },
  energy: {
    id: 'energy',
    name: 'Energy',
    icon: Zap,
    defaultFrom: 'kwh',
    defaultTo: 'joules',
    baseUnit: 'joules',
    units: {
      joules: { id: 'joules', name: 'Joules', symbol: 'J', toBase: 1, fromBase: 1 },
      kj: { id: 'kj', name: 'Kilojoules', symbol: 'kJ', toBase: 1000, fromBase: 0.001 },
      cal: { id: 'cal', name: 'Calories', symbol: 'cal', toBase: 4.184, fromBase: 1 / 4.184 },
      kcal: { id: 'kcal', name: 'Kilocalories', symbol: 'kcal', toBase: 4184, fromBase: 1 / 4184 },
      wh: { id: 'wh', name: 'Watt-hours', symbol: 'Wh', toBase: 3600, fromBase: 1 / 3600 },
      kwh: { id: 'kwh', name: 'Kilowatt-hours', symbol: 'kWh', toBase: 3600000, fromBase: 1 / 3600000 },
      btu: { id: 'btu', name: 'British Thermal Units', symbol: 'BTU', toBase: 1055.056, fromBase: 1 / 1055.056 },
    },
  },
};

const POPULAR_CONVERSIONS = [
  { label: 'Pounds to Kilograms', category: 'weight', from: 'lbs', to: 'kg' },
  { label: 'Kilograms to Pounds', category: 'weight', from: 'kg', to: 'lbs' },
  { label: 'Feet to Meters', category: 'length', from: 'feet', to: 'meters' },
  { label: 'Meters to Feet', category: 'length', from: 'meters', to: 'feet' },
  { label: 'Celsius to Fahrenheit', category: 'temperature', from: 'celsius', to: 'fahrenheit' },
  { label: 'Fahrenheit to Celsius', category: 'temperature', from: 'fahrenheit', to: 'celsius' },
  { label: 'Megabytes to Gigabytes', category: 'digital', from: 'mb', to: 'gb' },
  { label: 'Miles to Kilometers', category: 'length', from: 'miles', to: 'km' },
  { label: 'Inches to Centimeters', category: 'length', from: 'inches', to: 'cm' },
  { label: 'Bar to PSI', category: 'pressure', from: 'bar', to: 'psi' },
];

const REFERENCE_VALUES = [1, 5, 10, 20, 50, 100, 250, 500, 1000];

export function convertValue(val: number, fromDef: UnitDefinition, toDef: UnitDefinition): number {
  if (isNaN(val)) return 0;
  const baseVal = typeof fromDef.toBase === 'function' ? fromDef.toBase(val) : val * fromDef.toBase;
  return typeof toDef.fromBase === 'function' ? toDef.fromBase(baseVal) : baseVal * toDef.fromBase;
}

function getBreakdownCardClass(isTarget: boolean, isSelf: boolean): string {
  if (isTarget) {
    return 'bg-brand-50 dark:bg-dark-elevated border-brand-400 dark:border-brand-500/60 shadow-sm';
  }
  if (isSelf) {
    return 'bg-neutral-subtle dark:bg-dark-elevated/60 border-neutral-border dark:border-dark-border opacity-80';
  }
  return 'bg-neutral-scaffold dark:bg-dark-elevated border-neutral-border dark:border-dark-border hover:border-brand-400';
}

function resolveStartingCategory(initialCategory: string, initialSrc?: string, initialTgt?: string): string {
  if (initialSrc && initialTgt) {
    const srcLower = initialSrc.toLowerCase();
    const tgtLower = initialTgt.toLowerCase();
    for (const [catKey, catDef] of Object.entries(UNIT_CATEGORIES)) {
      if (catDef.units[srcLower] && catDef.units[tgtLower]) {
        return catKey;
      }
    }
  }
  return UNIT_CATEGORIES[initialCategory] ? initialCategory : 'weight';
}

function CategorySelectorBar({
  activeCategoryKey,
  onSelectCategory,
}: {
  activeCategoryKey: string;
  onSelectCategory: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Unit categories">
      {Object.entries(UNIT_CATEGORIES).map(([key, cat]) => {
        const Icon = cat.icon;
        const isActive = activeCategoryKey === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelectCategory(key)}
            className={`inline-flex items-center gap-2 min-h-[44px] px-3.5 py-2 rounded-md text-xs sm:text-sm font-semibold border transition-colors cursor-pointer ${
              isActive
                ? 'bg-brand-700 text-white border-brand-700'
                : 'bg-white dark:bg-dark-surface border-neutral-border dark:border-dark-border text-ink-secondary dark:text-neutral-300 hover:text-brand-950 dark:hover:text-white hover:border-brand-400'
            }`}
          >
            <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-brand-700 dark:text-brand-400'}`} aria-hidden="true" />
            <span>{cat.name}</span>
          </button>
        );
      })}
    </div>
  );
}

interface UnitWorkbenchProps {
  currentCategory: UnitCategory;
  fromDef: UnitDefinition;
  toDef: UnitDefinition;
  fromUnitKey: string;
  toUnitKey: string;
  inputStr: string;
  formattedResult: string;
  rawCopyValue: string;
  precision: number;
  formulaText: string;
  isCopied: boolean;
  onChangeInput: (next: string) => void;
  onChangeFromUnit: (next: string) => void;
  onChangeToUnit: (next: string) => void;
  onChangePrecision: (next: number) => void;
  onSwap: () => void;
  onCopyResult: (value: string) => void;
}

function UnitWorkbenchCard({ props }: { props: UnitWorkbenchProps }) {
  const {
    currentCategory,
    fromDef,
    toDef,
    fromUnitKey,
    toUnitKey,
    inputStr,
    formattedResult,
    rawCopyValue,
    precision,
    formulaText,
    isCopied,
    onChangeInput,
    onChangeFromUnit,
    onChangeToUnit,
    onChangePrecision,
    onSwap,
    onCopyResult,
  } = props;

  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-border dark:border-dark-border pb-5">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-brand-950 dark:text-white">
            {fromDef.name} to {toDef.name} Converter
          </h2>
          <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 mt-1">
            High-precision client calculation with zero network round-trips.
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <label
            htmlFor="unit-precision-select"
            className="text-xs font-semibold text-ink-secondary dark:text-neutral-300"
          >
            Decimals
          </label>
          <select
            id="unit-precision-select"
            value={precision}
            onChange={(e) => onChangePrecision(parseInt(e.target.value, 10))}
            className="min-h-[44px] px-3 py-2 rounded-md bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border text-base text-brand-950 dark:text-white font-medium focus:border-brand-700 outline-none cursor-pointer"
          >
            <option value={2}>2 decimals</option>
            <option value={4}>4 decimals</option>
            <option value={6}>6 decimals</option>
            <option value={8}>8 decimals</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] items-center gap-5">
        <div className="space-y-3 p-5 rounded-lg bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border">
          <label
            htmlFor="unit-from-value"
            className="block text-xs font-semibold uppercase tracking-wider text-ink-secondary dark:text-neutral-300"
          >
            From Value
          </label>
          <input
            id="unit-from-value"
            type="text"
            inputMode="decimal"
            value={inputStr}
            onChange={(e) => {
              const val = e.target.value;
              if (val === '' || val === '-' || /^-?\d*\.?\d*$/.test(val)) {
                onChangeInput(val);
              }
            }}
            placeholder="0"
            className="w-full min-h-[48px] px-4 py-2.5 rounded-md bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-brand-950 dark:text-white font-mono text-lg sm:text-xl font-bold focus:border-brand-700 outline-none transition-colors"
          />

          <label
            htmlFor="unit-from-select"
            className="block text-xs font-semibold text-ink-secondary dark:text-neutral-300 pt-1"
          >
            Source Unit
          </label>
          <select
            id="unit-from-select"
            value={fromUnitKey}
            onChange={(e) => onChangeFromUnit(e.target.value)}
            className="w-full min-h-[44px] px-3.5 py-2 rounded-md bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-base font-medium text-brand-950 dark:text-white focus:border-brand-700 outline-none cursor-pointer"
          >
            {Object.entries(currentCategory.units).map(([key, def]) => (
              <option key={key} value={key}>
                {def.name} ({def.symbol})
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-center">
          <button
            type="button"
            onClick={onSwap}
            aria-label="Swap source and target units"
            className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] p-2.5 rounded-md bg-neutral-scaffold hover:bg-brand-50 dark:bg-dark-elevated dark:hover:bg-dark-border text-brand-700 dark:text-brand-300 border border-neutral-border dark:border-dark-border transition-colors cursor-pointer"
          >
            <ArrowRightLeft className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 p-5 rounded-lg bg-brand-50/50 dark:bg-dark-elevated border border-brand-200 dark:border-dark-border">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="unit-to-value"
              className="block text-xs font-semibold uppercase tracking-wider text-brand-700 dark:text-brand-400"
            >
              Converted Result ({toDef.symbol})
            </label>
            <button
              type="button"
              onClick={() => onCopyResult(rawCopyValue)}
              aria-label="Copy converted result"
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 rounded-md text-xs font-semibold bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-brand-700 dark:text-brand-300 hover:border-brand-400 transition-colors cursor-pointer"
            >
              {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
              <span>{isCopied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>

          <input
            id="unit-to-value"
            type="text"
            readOnly
            value={`${formattedResult} ${toDef.symbol}`}
            className="w-full min-h-[48px] px-4 py-2.5 rounded-md bg-white dark:bg-dark-surface border border-brand-300 dark:border-dark-border text-brand-700 dark:text-brand-300 font-mono text-lg sm:text-xl font-bold outline-none"
          />

          <label
            htmlFor="unit-to-select"
            className="block text-xs font-semibold text-ink-secondary dark:text-neutral-300 pt-1"
          >
            Target Unit
          </label>
          <select
            id="unit-to-select"
            value={toUnitKey}
            onChange={(e) => onChangeToUnit(e.target.value)}
            className="w-full min-h-[44px] px-3.5 py-2 rounded-md bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-base font-medium text-brand-950 dark:text-white focus:border-brand-700 outline-none cursor-pointer"
          >
            {Object.entries(currentCategory.units).map(([key, def]) => (
              <option key={key} value={key}>
                {def.name} ({def.symbol})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="p-4 rounded-lg bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-ink-secondary dark:text-neutral-300">
          <HelpCircle className="w-4 h-4 text-brand-700 dark:text-brand-400 shrink-0" aria-hidden="true" />
          <span className="px-2 py-0.5 rounded bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border font-semibold text-brand-950 dark:text-white">
            Formula
          </span>
          <code className="font-mono text-brand-700 dark:text-brand-300 font-semibold">{formulaText}</code>
        </div>
        <span className="text-emerald-700 dark:text-emerald-400 font-semibold self-start sm:self-auto">
          100% In-Browser &amp; Private
        </span>
      </div>
    </section>
  );
}

interface ConversionRow {
  key: string;
  name: string;
  symbol: string;
  value: number;
}

function CategoryBreakdownSection({
  inputVal,
  fromName,
  categoryName,
  rows,
  fromUnitKey,
  toUnitKey,
  precision,
  copiedKey,
  onCopyRow,
}: {
  inputVal: number;
  fromName: string;
  categoryName: string;
  rows: ConversionRow[];
  fromUnitKey: string;
  toUnitKey: string;
  precision: number;
  copiedKey: string | null;
  onCopyRow: (text: string, key: string) => void;
}) {
  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
          {inputVal} {fromName} Converted to All {categoryName} Units
        </h2>
        <span className="text-xs text-ink-muted dark:text-neutral-400">
          {rows.length} units
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {rows.map((conv) => {
          const formatted = Number.isFinite(conv.value)
            ? conv.value.toLocaleString(undefined, { maximumFractionDigits: precision })
            : '0';
          const copyText = Number.isFinite(conv.value)
            ? parseFloat(conv.value.toFixed(precision)).toString()
            : '0';
          const cardClass = getBreakdownCardClass(conv.key === toUnitKey, conv.key === fromUnitKey);

          return (
            <div
              key={conv.key}
              className={`p-3.5 rounded-lg border transition-colors flex items-center justify-between gap-2 ${cardClass}`}
            >
              <div className="min-w-0">
                <div className="text-xs font-bold text-brand-950 dark:text-white truncate">
                  {conv.name}
                </div>
                <div className="text-sm font-mono font-bold text-brand-700 dark:text-brand-300 truncate">
                  {formatted} <span className="text-xs text-ink-muted font-sans">{conv.symbol}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onCopyRow(copyText, conv.key)}
                aria-label={`Copy ${conv.name} value`}
                className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] p-2 rounded-md text-ink-muted hover:text-brand-700 dark:hover:text-white hover:bg-brand-100 dark:hover:bg-dark-border transition-colors shrink-0 cursor-pointer"
              >
                {copiedKey === conv.key ? (
                  <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" />
                ) : (
                  <Copy className="w-4 h-4" aria-hidden="true" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function QuickReferenceSection({
  fromDef,
  toDef,
  precision,
}: {
  fromDef: UnitDefinition;
  toDef: UnitDefinition;
  precision: number;
}) {
  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm space-y-4">
      <h2 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
        {fromDef.name} to {toDef.name} Quick Reference Table
      </h2>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs sm:text-sm">
          <thead>
            <tr className="border-b border-neutral-border dark:border-dark-border text-ink-muted dark:text-neutral-400">
              <th scope="col" className="py-2.5 px-4 font-bold">{fromDef.name} ({fromDef.symbol})</th>
              <th scope="col" className="py-2.5 px-4 font-bold">{toDef.name} ({toDef.symbol})</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-border dark:divide-dark-border">
            {REFERENCE_VALUES.map((refVal) => {
              const converted = convertValue(refVal, fromDef, toDef);
              return (
                <tr key={refVal} className="hover:bg-neutral-subtle/50 dark:hover:bg-dark-elevated transition-colors">
                  <td className="py-2.5 px-4 font-mono font-semibold text-brand-950 dark:text-white">
                    {refVal} {fromDef.symbol}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-brand-700 dark:text-brand-300 font-bold">
                    {converted.toLocaleString(undefined, { maximumFractionDigits: precision })} {toDef.symbol}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PopularConversionsSection({
  onSelectPreset,
}: {
  onSelectPreset: (category: string, from: string, to: string) => void;
}) {
  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm space-y-4">
      <div className="flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-brand-700 dark:text-brand-400" aria-hidden="true" />
        <h2 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
          Popular Unit Conversions
        </h2>
      </div>

      <div className="flex flex-wrap gap-2.5">
        {POPULAR_CONVERSIONS.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => onSelectPreset(item.category, item.from, item.to)}
            className="min-h-[44px] px-3.5 py-2 rounded-md text-xs font-semibold bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border text-ink-secondary dark:text-neutral-300 hover:text-brand-950 dark:hover:text-white hover:border-brand-400 transition-colors cursor-pointer"
          >
            {item.label}
          </button>
        ))}
      </div>
    </section>
  );
}

interface UnitConverterProps {
  initialCategory?: string;
  initialSrc?: string;
  initialTgt?: string;
}

export default function UnitConverter({
  initialCategory = 'weight',
  initialSrc,
  initialTgt,
}: UnitConverterProps) {
  const resolvedCategory = useMemo(
    () => resolveStartingCategory(initialCategory, initialSrc, initialTgt),
    [initialCategory, initialSrc, initialTgt]
  );

  const [activeCategoryKey, setActiveCategoryKey] = useState<string>(resolvedCategory);
  const currentCategory = UNIT_CATEGORIES[activeCategoryKey] || UNIT_CATEGORIES.weight;
  const [inputStr, setInputStr] = useState<string>('1');

  const inputVal = useMemo(() => {
    if (inputStr === '' || inputStr === '-' || inputStr === '.') return 0;
    const num = parseFloat(inputStr);
    return isNaN(num) ? 0 : num;
  }, [inputStr]);

  const [fromUnitKey, setFromUnitKey] = useState<string>(
    initialSrc && currentCategory.units[initialSrc.toLowerCase()]
      ? initialSrc.toLowerCase()
      : currentCategory.defaultFrom
  );
  const [toUnitKey, setToUnitKey] = useState<string>(
    initialTgt && currentCategory.units[initialTgt.toLowerCase()]
      ? initialTgt.toLowerCase()
      : currentCategory.defaultTo
  );
  const [precision, setPrecision] = useState<number>(6);
  const [isCopied, setIsCopied] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleSelectCategory = (catKey: string) => {
    setActiveCategoryKey(catKey);
    const cat = UNIT_CATEGORIES[catKey];
    if (cat) {
      setFromUnitKey(cat.defaultFrom);
      setToUnitKey(cat.defaultTo);
    }
  };

  const fromDef = currentCategory.units[fromUnitKey] || Object.values(currentCategory.units)[0];
  const toDef = currentCategory.units[toUnitKey] || Object.values(currentCategory.units)[1];

  const calculatedResult = useMemo(
    () => convertValue(inputVal, fromDef, toDef),
    [inputVal, fromDef, toDef]
  );

  const formattedResult = useMemo(() => {
    if (!Number.isFinite(calculatedResult)) return '0';
    return parseFloat(calculatedResult.toFixed(precision)).toLocaleString(undefined, {
      maximumFractionDigits: precision,
    });
  }, [calculatedResult, precision]);

  const rawCopyValue = useMemo(() => {
    if (!Number.isFinite(calculatedResult)) return '0';
    return parseFloat(calculatedResult.toFixed(precision)).toString();
  }, [calculatedResult, precision]);

  const handleSwap = () => {
    setFromUnitKey(toUnitKey);
    setToUnitKey(fromUnitKey);
    if (Number.isFinite(calculatedResult) && calculatedResult !== 0) {
      setInputStr(String(parseFloat(calculatedResult.toFixed(precision))));
    }
  };

  const handleCopy = (textToCopy: string, key?: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(textToCopy);
      if (key) {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 1500);
      } else {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 1500);
      }
    }
  };

  const allCategoryConversions = useMemo(
    () =>
      Object.entries(currentCategory.units).map(([key, def]) => ({
        key,
        name: def.name,
        symbol: def.symbol,
        value: convertValue(inputVal, fromDef, def),
      })),
    [inputVal, fromDef, currentCategory]
  );

  const formulaText = useMemo(() => {
    if (currentCategory.formulaDescription) {
      return currentCategory.formulaDescription(fromUnitKey, toUnitKey, inputVal, calculatedResult);
    }
    const unitRatio = convertValue(1, fromDef, toDef);
    return `1 ${fromDef.symbol} = ${unitRatio.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toDef.symbol}`;
  }, [currentCategory, fromDef, toDef, fromUnitKey, toUnitKey, inputVal, calculatedResult]);

  return (
    <div className="w-full space-y-8">
      <CategorySelectorBar
        activeCategoryKey={activeCategoryKey}
        onSelectCategory={handleSelectCategory}
      />

      <UnitWorkbenchCard
        props={{
          currentCategory,
          fromDef,
          toDef,
          fromUnitKey,
          toUnitKey,
          inputStr,
          formattedResult,
          rawCopyValue,
          precision,
          formulaText,
          isCopied,
          onChangeInput: setInputStr,
          onChangeFromUnit: setFromUnitKey,
          onChangeToUnit: setToUnitKey,
          onChangePrecision: setPrecision,
          onSwap: handleSwap,
          onCopyResult: (val) => handleCopy(val),
        }}
      />

      <CategoryBreakdownSection
        inputVal={inputVal}
        fromName={fromDef.name}
        categoryName={currentCategory.name}
        rows={allCategoryConversions}
        fromUnitKey={fromUnitKey}
        toUnitKey={toUnitKey}
        precision={precision}
        copiedKey={copiedKey}
        onCopyRow={(text, key) => handleCopy(text, key)}
      />

      <QuickReferenceSection fromDef={fromDef} toDef={toDef} precision={precision} />

      <PopularConversionsSection
        onSelectPreset={(category, from, to) => {
          setActiveCategoryKey(category);
          setFromUnitKey(from);
          setToUnitKey(to);
        }}
      />
    </div>
  );
}
