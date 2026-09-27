import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BRAND_PALETTE } from '../src/lib/theme';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { UNIT_CATEGORIES, convertValue } from '../src/components/UnitConverter';

describe('Brand Signature Palette & Design Tokens Verification', () => {
  it('verifies exact Brand Palette color tokens match specification', () => {
    // brand.700: #5C6BC0 (Main signature accent)
    expect(BRAND_PALETTE.brand[700].toUpperCase()).toBe('#5C6BC0');
    // brand.400: #B4BCFB (Signature surface)
    expect(BRAND_PALETTE.brand[400].toUpperCase()).toBe('#B4BCFB');
    // brand.50: #F8F9FF (Chrome / top bar surface)
    expect(BRAND_PALETTE.brand[50].toUpperCase()).toBe('#F8F9FF');
    // brand.100: #F0F2FE (Secondary button background)
    expect(BRAND_PALETTE.brand[100].toUpperCase()).toBe('#F0F2FE');
    // brand.200: #E2E5FD (Secondary button pressed)
    expect(BRAND_PALETTE.brand[200].toUpperCase()).toBe('#E2E5FD');
    // brand.300: #CCD2FC (Decorative divider)
    expect(BRAND_PALETTE.brand[300].toUpperCase()).toBe('#CCD2FC');
    // brand.600: #7480D2 (Secondary button border)
    expect(BRAND_PALETTE.brand[600].toUpperCase()).toBe('#7480D2');
    // brand.800: #4A58A9 (Main CTA button pressed)
    expect(BRAND_PALETTE.brand[800].toUpperCase()).toBe('#4A58A9');
    // brand.900: #3B4890 (Signature surface text/border)
    expect(BRAND_PALETTE.brand[900].toUpperCase()).toBe('#3B4890');
    // brand.950: #1F2340 (Content primary body text)
    expect(BRAND_PALETTE.brand[950].toUpperCase()).toBe('#1F2340');
  });

  it('verifies Neutral & Ink palette color tokens match specification', () => {
    expect(BRAND_PALETTE.neutral.white.toUpperCase()).toBe('#FFFFFF');
    expect(BRAND_PALETTE.neutral.scaffold.toUpperCase()).toBe('#F7F8FC');
    expect(BRAND_PALETTE.neutral.subtle.toUpperCase()).toBe('#F0F2F7');
    expect(BRAND_PALETTE.neutral.border.toUpperCase()).toBe('#E1E4EE');
    expect(BRAND_PALETTE.ink.secondary.toUpperCase()).toBe('#4D536B');
    expect(BRAND_PALETTE.ink.muted.toUpperCase()).toBe('#697089');
    expect(BRAND_PALETTE.ink.primary.toUpperCase()).toBe('#1F2340');
  });

  it('verifies official logo.svg and icon.svg contain the circular emblem badge, EC monogram, lavender arrow, and valid XML', () => {
    const logoSvg = fs.readFileSync(path.join(process.cwd(), 'public/logo.svg'), 'utf-8');
    const iconSvg = fs.readFileSync(path.join(process.cwd(), 'public/icon.svg'), 'utf-8');

    // Must not contain invalid JSX comments
    expect(logoSvg).not.toContain('{/*');
    expect(logoSvg).not.toContain('*/}');
    expect(iconSvg).not.toContain('{/*');
    expect(iconSvg).not.toContain('*/}');

    // Check signature palette colors and elements
    expect(logoSvg).toContain('#5C6BC0');
    expect(iconSvg).toContain('#5C6BC0');
    expect(logoSvg).toContain('#B4BCFB');
    expect(iconSvg).toContain('#B4BCFB');
    expect(logoSvg).toContain('#F4F5FD');
    expect(iconSvg).toContain('#F4F5FD');
    expect(logoSvg).toContain('#1F2340');
    expect(logoSvg).toContain('EasyConvert');

    // Background plate for icon.svg
    expect(iconSvg).toContain('<rect width="120" height="120" rx="28" fill="#F8F9FF" />');

    // Must not contain obsolete loop badge strings
    expect(logoSvg).not.toContain('badge-pdf');
    expect(iconSvg).not.toContain('badge-pdf');
    expect(logoSvg).not.toContain('badge-doc');
    expect(iconSvg).not.toContain('badge-doc');
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
    expect(parsed.pageTitle).toBe('System Status');
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
