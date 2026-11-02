import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { slugPageCopy } from './helpers/intl';
import { UNIT_CATEGORIES, convertValue } from '../src/components/UnitConverter';
import sharp from 'sharp';
import { oracleTest } from './helpers/oracle-test';
import { xmlWellFormed, xpathAttributes, xpathCount, xpathString } from './helpers/xml-oracle';

const appFile = (name: string) => fs.readFileSync(path.join(process.cwd(), 'src', 'app', name));

/** The browser icons: QA's mark, its small form (tile to the edge, no glow, rim or shadow) up to 32 px, the full form above. */
describe('the brand icon files', () => {
  oracleTest('draw the small mark as a full-bleed tile with three bars and a chevron, and nothing that blurs at tab size', ['xmllint'], async () => {
    const svg = appFile('icon.svg').toString('utf8');
    expect(xmlWellFormed(svg).ok).toBe(true);
    expect(xpathAttributes(svg, "/*[local-name()='svg']/@viewBox")).toEqual(['8 8 112 112']);
    expect(['x', 'y', 'width', 'height'].map((a) => xpathString(svg, `string(//*[local-name()='rect']/@${a})`))).toEqual(['8', '8', '112', '112']);
    expect(xpathCount(svg, "//*[local-name()='path']")).toBe(4);
    expect(xpathCount(svg, "//*[local-name()='filter' or local-name()='radialGradient']")).toBe(0);
    expect(xpathCount(svg, "//*[@stroke]")).toBe(0);
  });

  it('keep three bars apart at 32 px and the tile to the edge, with only the rounded corner left clear', async () => {
    const { data, info } = await sharp(appFile('icon.svg'), { density: 72 }).resize(32, 32).raw().toBuffer({ resolveWithObject: true });
    const lum = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
    };
    const column = 6;
    const rows = Array.from({ length: 32 }, (_, y) => lum(column, y) > 150);
    const bars = rows.filter((light, y) => light && !rows[y - 1]).length;
    expect(bars).toBe(3);
    expect(data[3]).toBe(0);
    expect(data[(16 * info.width) * info.channels + 3]).toBe(255);
  });

  it('pack 16 and 32 px images in the favicon and a 180 px touch icon', async () => {
    const ico = appFile('favicon.ico');
    expect(ico.readUInt16LE(2)).toBe(1);
    expect([ico.readUInt8(6), ico.readUInt8(22)]).toEqual([16, 32]);
    const apple = await sharp(appFile('apple-icon.png')).metadata();
    expect([apple.width, apple.height]).toEqual([180, 180]);
  });
});

describe('Unit Converter Multi-Category Mathematical Accuracy', () => {
  it('converts Weight & Mass accurately (Pounds to Kilograms)', () => {
    const weightCat = UNIT_CATEGORIES.weight;
    const lbsDef = weightCat.units.lbs;
    const kgDef = weightCat.units.kg;

    // 1 lb = 0.45359237 kg
    const kg = convertValue(1, lbsDef, kgDef);
    expect(kg).toBeCloseTo(0.453592, 5);

    // 100 kg = ~220.462 lbs
    const lbs = convertValue(100, kgDef, lbsDef);
    expect(lbs).toBeCloseTo(220.462, 2);

    // 1 oz = 28.3495 g
    const ozDef = weightCat.units.oz;
    const gDef = weightCat.units.g;
    expect(convertValue(1, ozDef, gDef)).toBeCloseTo(28.3495, 4);
  });

  it('converts Length accurately (Meters to Feet & Inches)', () => {
    const lenCat = UNIT_CATEGORIES.length;
    const mDef = lenCat.units.meters;
    const ftDef = lenCat.units.feet;
    const inDef = lenCat.units.inches;

    // 1 meter = 3.28084 feet
    expect(convertValue(1, mDef, ftDef)).toBeCloseTo(3.28084, 4);

    // 1 foot = 12 inches
    expect(convertValue(1, ftDef, inDef)).toBeCloseTo(12, 4);

    // 1 km = 0.621371 miles
    const kmDef = lenCat.units.km;
    const miDef = lenCat.units.miles;
    expect(convertValue(1, kmDef, miDef)).toBeCloseTo(0.621371, 5);
  });

  it('converts Temperature non-linearly (Celsius, Fahrenheit, Kelvin)', () => {
    const tempCat = UNIT_CATEGORIES.temperature;
    const cDef = tempCat.units.celsius;
    const fDef = tempCat.units.fahrenheit;
    const kDef = tempCat.units.kelvin;

    // Freezing point: 0°C = 32°F = 273.15 K
    expect(convertValue(0, cDef, fDef)).toBe(32);
    expect(convertValue(0, cDef, kDef)).toBe(273.15);

    // Boiling point: 100°C = 212°F = 373.15 K
    expect(convertValue(100, cDef, fDef)).toBe(212);
    expect(convertValue(100, cDef, kDef)).toBe(373.15);

    // Human body temp: 98.6°F = 37°C
    expect(convertValue(98.6, fDef, cDef)).toBeCloseTo(37, 2);

    // Negative temperature: -40°C = -40°F
    expect(convertValue(-40, cDef, fDef)).toBe(-40);
  });

  it('converts Digital Storage units (Decimal vs Binary prefixes)', () => {
    const digCat = UNIT_CATEGORIES.digital;
    const mbDef = digCat.units.mb;
    const gbDef = digCat.units.gb;
    const mibDef = digCat.units.mib;
    const gibDef = digCat.units.gib;

    // 1,000 MB = 1 GB (Decimal)
    expect(convertValue(1000, mbDef, gbDef)).toBeCloseTo(1, 6);

    // 1,024 MiB = 1 GiB (Binary)
    expect(convertValue(1024, mibDef, gibDef)).toBeCloseTo(1, 6);

    // 1 GiB = 1,073,741,824 bytes
    const bDef = digCat.units.bytes;
    expect(convertValue(1, gibDef, bDef)).toBe(1073741824);
  });

  it('converts Area, Volume, Speed, Time, Pressure, and Energy', () => {
    // Area: 1 hectare = 10,000 sqm
    expect(convertValue(1, UNIT_CATEGORIES.area.units.hectares, UNIT_CATEGORIES.area.units.sqm)).toBe(10000);

    // Volume: 1 US gallon = ~3.78541 liters
    expect(convertValue(1, UNIT_CATEGORIES.volume.units.gallons, UNIT_CATEGORIES.volume.units.liters)).toBeCloseTo(3.78541, 4);

    // Speed: 100 km/h = ~62.1371 mph
    expect(convertValue(100, UNIT_CATEGORIES.speed.units.kmh, UNIT_CATEGORIES.speed.units.mph)).toBeCloseTo(62.1371, 3);

    // Time: 1 hour = 3600 seconds
    expect(convertValue(1, UNIT_CATEGORIES.time.units.hours, UNIT_CATEGORIES.time.units.seconds)).toBe(3600);

    // Pressure: 1 bar = ~14.5038 psi
    expect(convertValue(1, UNIT_CATEGORIES.pressure.units.bar, UNIT_CATEGORIES.pressure.units.psi)).toBeCloseTo(14.5038, 3);

    // Energy: 1 kWh = 3,600,000 Joules
    expect(convertValue(1, UNIT_CATEGORIES.energy.units.kwh, UNIT_CATEGORIES.energy.units.joules)).toBe(3600000);
  });

  it('converts extended units accurately (micrograms, rankine, mach, petabytes, imperial gallons)', () => {
    // Micrograms to Grams
    expect(convertValue(1000000, UNIT_CATEGORIES.weight.units.mcg, UNIT_CATEGORIES.weight.units.g)).toBe(1);

    // Rankine to Fahrenheit: 0°F = 459.67°R
    expect(convertValue(459.67, UNIT_CATEGORIES.temperature.units.rankine, UNIT_CATEGORIES.temperature.units.fahrenheit)).toBeCloseTo(0, 2);

    // Micrometers to Millimeters
    expect(convertValue(1000, UNIT_CATEGORIES.length.units.um, UNIT_CATEGORIES.length.units.mm)).toBe(1);

    // Imperial Gallons to Liters: 1 imp gal = 4.54609 L
    expect(convertValue(1, UNIT_CATEGORIES.volume.units.impgal, UNIT_CATEGORIES.volume.units.liters)).toBeCloseTo(4.54609, 4);

    // Mach to km/h: Mach 1 = 343 m/s = 1234.8 km/h
    expect(convertValue(1, UNIT_CATEGORIES.speed.units.mach, UNIT_CATEGORIES.speed.units.kmh)).toBeCloseTo(1234.8, 1);

    // Petabytes to Terabytes
    expect(convertValue(1, UNIT_CATEGORIES.digital.units.pb, UNIT_CATEGORIES.digital.units.tb)).toBe(1000);

    // Tebibytes to Gibibytes
    expect(convertValue(1, UNIT_CATEGORIES.digital.units.tib, UNIT_CATEGORIES.digital.units.gib)).toBe(1024);
  });

  it('handles edge cases safely (NaN, 0, large quantities)', () => {
    const weightCat = UNIT_CATEGORIES.weight;
    expect(convertValue(NaN, weightCat.units.lbs, weightCat.units.kg)).toBe(0);
    expect(convertValue(0, weightCat.units.lbs, weightCat.units.kg)).toBe(0);
    expect(convertValue(1e6, weightCat.units.kg, weightCat.units.ton)).toBe(1000);
  });
});

describe('Slug Parser Integration for Status and Unit Converter', () => {
  it('correctly maps status slug to informational status page', () => {
    const parsed = parseConverterSlug('status');
    expect(parsed.isInfoPage).toBe(true);
    expect(parsed.infoType).toBe('status');
    expect(slugPageCopy('status').title).toBe('System Status');
  });

  it('correctly maps unit-converter slug to unit page', () => {
    const parsed = parseConverterSlug('unit-converter');
    expect(parsed.isInfoPage).toBe(true);
    expect(parsed.infoType).toBe('unit');
    expect(parsed.sourceFormat).toBe('lbs');
    expect(parsed.targetFormat).toBe('kg');
  });

  it('correctly routes format pair slugs like lbs-to-kg to unit converter', () => {
    const lbsToKg = parseConverterSlug('lbs-to-kg');
    expect(lbsToKg.isInfoPage).toBe(true);
    expect(lbsToKg.infoType).toBe('unit');
    expect(lbsToKg.sourceFormat).toBe('lbs');
    expect(lbsToKg.targetFormat).toBe('kg');

    const kgToLbs = parseConverterSlug('kg-to-lbs');
    expect(kgToLbs.isInfoPage).toBe(true);
    expect(kgToLbs.infoType).toBe('unit');
    expect(kgToLbs.sourceFormat).toBe('kg');
    expect(kgToLbs.targetFormat).toBe('lbs');

    const feetToMeters = parseConverterSlug('feet-to-meters');
    expect(feetToMeters.isInfoPage).toBe(true);
    expect(feetToMeters.infoType).toBe('unit');
    expect(feetToMeters.sourceFormat).toBe('feet');
    expect(feetToMeters.targetFormat).toBe('meters');
  });
});
