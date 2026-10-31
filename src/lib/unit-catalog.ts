import type { ComponentType } from 'react';
import {
  Box, Clock, Compass, Gauge, HardDrive, Maximize2, Ruler, Scale, Thermometer, Zap,
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
  icon: ComponentType<{ className?: string }>;
  defaultFrom: string;
  defaultTo: string;
  baseUnit: string;
  units: Record<string, UnitDefinition>;
  formulaDescription?: (from: string, to: string, val: number, res: number) => string;
}

export interface PopularConversionItem {
  label: string;
  category: string;
  from: string;
  to: string;
}

export const UNIT_CATEGORIES: Record<string, UnitCategory> = {
  weight: {
    id: 'weight', name: 'Weight & Mass', icon: Scale, defaultFrom: 'lbs', defaultTo: 'kg', baseUnit: 'g',
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
    id: 'length', name: 'Length', icon: Ruler, defaultFrom: 'meters', defaultTo: 'feet', baseUnit: 'm',
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
    id: 'temperature', name: 'Temperature', icon: Thermometer, defaultFrom: 'celsius', defaultTo: 'fahrenheit', baseUnit: 'celsius',
    units: {
      celsius: { id: 'celsius', name: 'Celsius', symbol: '°C', toBase: (v) => v, fromBase: (v) => v },
      fahrenheit: { id: 'fahrenheit', name: 'Fahrenheit', symbol: '°F', toBase: (v) => ((v - 32) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 32 },
      kelvin: { id: 'kelvin', name: 'Kelvin', symbol: 'K', toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
      rankine: { id: 'rankine', name: 'Rankine', symbol: '°R', toBase: (v) => ((v - 491.67) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 491.67 },
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
    id: 'area', name: 'Area', icon: Maximize2, defaultFrom: 'sqm', defaultTo: 'sqft', baseUnit: 'sqm',
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
    id: 'volume', name: 'Volume', icon: Box, defaultFrom: 'liters', defaultTo: 'gallons', baseUnit: 'liters',
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
    id: 'speed', name: 'Speed', icon: Gauge, defaultFrom: 'kmh', defaultTo: 'mph', baseUnit: 'ms',
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
    id: 'digital', name: 'Digital Storage', icon: HardDrive, defaultFrom: 'mb', defaultTo: 'gb', baseUnit: 'bytes',
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
    id: 'time', name: 'Time', icon: Clock, defaultFrom: 'hours', defaultTo: 'minutes', baseUnit: 'seconds',
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
    id: 'pressure', name: 'Pressure', icon: Compass, defaultFrom: 'bar', defaultTo: 'psi', baseUnit: 'pascal',
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
    id: 'energy', name: 'Energy', icon: Zap, defaultFrom: 'kwh', defaultTo: 'joules', baseUnit: 'joules',
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

export const POPULAR_CONVERSIONS: ReadonlyArray<PopularConversionItem> = [
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

export const REFERENCE_VALUES: ReadonlyArray<number> = [1, 5, 10, 20, 50, 100, 250, 500, 1000];

export function convertValue(val: number, fromDef: UnitDefinition, toDef: UnitDefinition): number {
  if (Number.isNaN(val)) return 0;
  const baseVal = typeof fromDef.toBase === 'function' ? fromDef.toBase(val) : val * fromDef.toBase;
  return typeof toDef.fromBase === 'function' ? toDef.fromBase(baseVal) : baseVal * toDef.fromBase;
}

export function resolveStartingCategory(initialCategory: string, initialSrc?: string, initialTgt?: string): string {
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
