'use client';

import React, { useState, useMemo } from 'react';
import {
  RefreshCw,
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

export function convertValue(val: number, fromDef: UnitDefinition, toDef: UnitDefinition): number {
  if (isNaN(val)) return 0;
  // Base conversion
  let baseVal = 0;
  if (typeof fromDef.toBase === 'function') {
    baseVal = fromDef.toBase(val);
  } else {
    baseVal = val * fromDef.toBase;
  }

  // Target conversion
  let targetVal = 0;
  if (typeof toDef.fromBase === 'function') {
    targetVal = toDef.fromBase(baseVal);
  } else {
    targetVal = baseVal * toDef.fromBase;
  }

  return targetVal;
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
  // Determine starting category and units
  const resolvedCategory = useMemo(() => {
    if (initialSrc && initialTgt) {
      for (const [catKey, catDef] of Object.entries(UNIT_CATEGORIES)) {
        if (catDef.units[initialSrc.toLowerCase()] && catDef.units[initialTgt.toLowerCase()]) {
          return catKey;
        }
      }
    }
    return UNIT_CATEGORIES[initialCategory] ? initialCategory : 'weight';
  }, [initialCategory, initialSrc, initialTgt]);

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

  // Switch category
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

  const calculatedResult = useMemo(() => {
    return convertValue(inputVal, fromDef, toDef);
  }, [inputVal, fromDef, toDef]);

  const rawCopyValue = useMemo(() => {
    if (!Number.isFinite(calculatedResult)) return '0';
    return parseFloat(calculatedResult.toFixed(precision)).toString();
  }, [calculatedResult, precision]);

  const handleSwap = () => {
    const tmp = fromUnitKey;
    setFromUnitKey(toUnitKey);
    setToUnitKey(tmp);
    if (Number.isFinite(calculatedResult) && calculatedResult !== 0) {
      const fixed = parseFloat(calculatedResult.toFixed(precision));
      setInputStr(String(fixed));
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

  // Common reference lookup table (1, 5, 10, 20, 50, 100, 250, 500, 1000)
  const referenceValues = [1, 5, 10, 20, 50, 100, 250, 500, 1000];

  // All other units in the current category
  const allCategoryConversions = useMemo(() => {
    return Object.entries(currentCategory.units).map(([key, def]) => {
      const val = convertValue(inputVal, fromDef, def);
      return {
        key,
        name: def.name,
        symbol: def.symbol,
        value: val,
      };
    });
  }, [inputVal, fromDef, currentCategory]);

  // Dynamic formula generation
  const formulaText = useMemo(() => {
    if (currentCategory.formulaDescription) {
      return currentCategory.formulaDescription(fromUnitKey, toUnitKey, inputVal, calculatedResult);
    }
    const unitRatio = convertValue(1, fromDef, toDef);
    return `1 ${fromDef.symbol} = ${unitRatio.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toDef.symbol}`;
  }, [currentCategory, fromDef, toDef, fromUnitKey, toUnitKey, inputVal, calculatedResult]);

  return (
    <div className="w-full space-y-10">
      {/* Category Switcher Tabs */}
      <div className="flex items-center overflow-x-auto pb-2 scrollbar-none gap-2">
        {Object.entries(UNIT_CATEGORIES).map(([key, cat]) => {
          const Icon = cat.icon;
          const isActive = activeCategoryKey === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => handleSelectCategory(key)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs sm:text-sm font-bold whitespace-nowrap transition-all cursor-pointer ${
                isActive
                  ? 'bg-brand-700 text-white shadow-md shadow-brand-700/25 scale-[1.02]'
                  : 'bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-ink-secondary dark:text-neutral-300 hover:text-brand-950 dark:hover:text-white hover:border-brand-400'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-brand-700 dark:text-brand-400'}`} />
              <span>{cat.name}</span>
            </button>
          );
        })}
      </div>

      {/* Main Interactive Dual Conversion Card */}
      <div className="rounded-3xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-10 shadow-xl space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-border dark:border-dark-border pb-6">
          <div>
            <h2 className="text-xl sm:text-2xl font-extrabold text-brand-950 dark:text-white">
              {fromDef.name} to {toDef.name} Converter
            </h2>
            <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 mt-1">
              Real-time high-precision client calculation with zero network latency.
            </p>
          </div>

          {/* Precision Selector */}
          <div className="flex items-center gap-2 self-start sm:self-auto text-xs text-ink-secondary dark:text-neutral-400">
            <span>Decimals:</span>
            <select
              value={precision}
              onChange={(e) => setPrecision(parseInt(e.target.value, 10))}
              className="px-2.5 py-1 rounded-lg bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border text-brand-950 dark:text-white font-medium outline-none cursor-pointer"
            >
              <option value={2}>2 decimals</option>
              <option value={4}>4 decimals</option>
              <option value={6}>6 decimals</option>
              <option value={8}>8 decimals</option>
            </select>
          </div>
        </div>

        {/* Dual Input Conversion Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] items-center gap-6">
          {/* FROM Input & Unit */}
          <div className="space-y-2.5 p-5 rounded-2xl bg-neutral-scaffold dark:bg-white/5 border border-neutral-border dark:border-dark-border">
            <label className="block text-xs font-bold uppercase tracking-wider text-ink-muted dark:text-neutral-400">
              From
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={inputStr}
              onChange={(e) => {
                const val = e.target.value;
                if (val === '' || val === '-' || /^-?\d*\.?\d*$/.test(val)) {
                  setInputStr(val);
                }
              }}
              placeholder="0"
              className="w-full px-4 py-3 rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-brand-950 dark:text-white font-mono text-xl sm:text-2xl font-bold focus:border-brand-700 outline-none transition-colors"
            />
            <select
              value={fromUnitKey}
              onChange={(e) => setFromUnitKey(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-xs sm:text-sm font-semibold text-brand-950 dark:text-white focus:border-brand-700 outline-none cursor-pointer"
            >
              {Object.entries(currentCategory.units).map(([key, def]) => (
                <option key={key} value={key}>
                  {def.name} ({def.symbol})
                </option>
              ))}
            </select>
          </div>

          {/* Swap Button */}
          <div className="flex justify-center -my-2 lg:my-0">
            <button
              type="button"
              onClick={handleSwap}
              aria-label="Swap source and target units"
              className="p-3.5 rounded-full bg-brand-100 hover:bg-brand-200 dark:bg-white/10 dark:hover:bg-white/15 text-brand-700 dark:text-brand-300 border border-brand-600/30 dark:border-white/15 shadow-sm transition-transform hover:rotate-180 duration-200 cursor-pointer"
            >
              <ArrowRightLeft className="w-5 h-5" />
            </button>
          </div>

          {/* TO Output & Unit */}
          <div className="space-y-2.5 p-5 rounded-2xl bg-brand-50/60 dark:bg-white/5 border border-brand-300/60 dark:border-dark-border">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400">
                To (Calculated)
              </label>
              <button
                type="button"
                onClick={() => handleCopy(rawCopyValue)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 dark:text-brand-300 hover:underline cursor-pointer"
              >
                {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{isCopied ? 'Copied!' : 'Copy'}</span>
              </button>
            </div>
            <div className="w-full px-4 py-3 rounded-xl bg-white dark:bg-dark-surface border border-brand-300 dark:border-dark-border text-brand-700 dark:text-brand-300 font-mono text-xl sm:text-2xl font-bold truncate flex items-center justify-between">
              <span>
                {Number.isFinite(calculatedResult)
                  ? parseFloat(calculatedResult.toFixed(precision)).toLocaleString(undefined, {
                      maximumFractionDigits: precision,
                    })
                  : '0'}
              </span>
              <span className="text-xs font-normal text-ink-muted dark:text-neutral-400 font-sans ml-2">
                {toDef.symbol}
              </span>
            </div>
            <select
              value={toUnitKey}
              onChange={(e) => setToUnitKey(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-xs sm:text-sm font-semibold text-brand-950 dark:text-white focus:border-brand-700 outline-none cursor-pointer"
            >
              {Object.entries(currentCategory.units).map(([key, def]) => (
                <option key={key} value={key}>
                  {def.name} ({def.symbol})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Formula & Explanation Ribbon */}
        <div className="p-4 rounded-2xl bg-neutral-scaffold dark:bg-white/5 border border-neutral-border dark:border-dark-border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-ink-secondary dark:text-neutral-300">
            <HelpCircle className="w-4 h-4 text-brand-700 dark:text-brand-400 shrink-0" />
            <span className="font-semibold text-brand-950 dark:text-white">Conversion Formula:</span>
            <span className="font-mono text-brand-700 dark:text-brand-300 font-bold">{formulaText}</span>
          </div>
          <span className="text-emerald-700 dark:text-emerald-400 font-semibold self-start sm:self-auto">
            100% In-Browser & Private
          </span>
        </div>
      </div>

      {/* Multi-Unit Breakdown: Convert [Value] [FromUnit] into ALL other units in category */}
      <div className="rounded-3xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
            {inputVal} {fromDef.name} Converted to All {currentCategory.name} Units
          </h3>
          <span className="text-xs text-ink-muted dark:text-neutral-400">
            {allCategoryConversions.length} units
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {allCategoryConversions.map((conv) => {
            const formatted = Number.isFinite(conv.value)
              ? conv.value.toLocaleString(undefined, { maximumFractionDigits: precision })
              : '0';
            const isTarget = conv.key === toUnitKey;
            const isSelf = conv.key === fromUnitKey;

            return (
              <div
                key={conv.key}
                className={`p-3.5 rounded-2xl border transition-all flex items-center justify-between gap-2 ${
                  isTarget
                    ? 'bg-brand-50 dark:bg-white/10 border-brand-400 dark:border-brand-400/50 shadow-sm'
                    : isSelf
                    ? 'bg-neutral-subtle dark:bg-white/5 border-neutral-border dark:border-dark-border opacity-70'
                    : 'bg-neutral-scaffold dark:bg-white/5 border-neutral-border dark:border-dark-border hover:border-brand-300'
                }`}
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
                  onClick={() =>
                    handleCopy(
                      Number.isFinite(conv.value) ? parseFloat(conv.value.toFixed(precision)).toString() : '0',
                      conv.key
                    )
                  }
                  title="Copy value"
                  className="p-1.5 rounded-lg text-ink-muted hover:text-brand-700 dark:hover:text-white hover:bg-brand-100 dark:hover:bg-white/10 transition-colors shrink-0 cursor-pointer"
                >
                  {copiedKey === conv.key ? (
                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick Lookup Reference Matrix */}
      <div className="rounded-3xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm space-y-4">
        <h3 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
          {fromDef.name} to {toDef.name} Quick Reference Table
        </h3>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-neutral-border dark:border-dark-border text-ink-muted dark:text-neutral-400">
                <th className="py-2.5 px-4 font-bold">{fromDef.name} ({fromDef.symbol})</th>
                <th className="py-2.5 px-4 font-bold">{toDef.name} ({toDef.symbol})</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-border dark:divide-dark-border">
              {referenceValues.map((refVal) => {
                const converted = convertValue(refVal, fromDef, toDef);
                return (
                  <tr key={refVal} className="hover:bg-neutral-subtle/50 dark:hover:bg-white/5 transition-colors">
                    <td className="py-2 px-4 font-mono font-semibold text-brand-950 dark:text-white">
                      {refVal} {fromDef.symbol}
                    </td>
                    <td className="py-2 px-4 font-mono text-brand-700 dark:text-brand-300 font-bold">
                      {converted.toLocaleString(undefined, { maximumFractionDigits: precision })} {toDef.symbol}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Popular Unit Conversions Fast Selector */}
      <div className="rounded-3xl bg-neutral-scaffold dark:bg-white/5 border border-neutral-border dark:border-dark-border p-6 sm:p-8 space-y-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-brand-700 dark:text-brand-400" />
          <h3 className="text-sm sm:text-base font-bold text-brand-950 dark:text-white">
            Popular Unit Conversions
          </h3>
        </div>

        <div className="flex flex-wrap gap-2.5">
          {POPULAR_CONVERSIONS.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setActiveCategoryKey(item.category);
                setFromUnitKey(item.from);
                setToUnitKey(item.to);
              }}
              className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-ink-secondary dark:text-neutral-300 hover:text-brand-950 dark:hover:text-white hover:border-brand-400 shadow-sm transition-all cursor-pointer"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
