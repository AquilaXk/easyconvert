/** Binary multiples. The API, logs and OpenAPI carry the IEC names (a 1 GiB limit reads "1 GiB"); web pages show them as KB, MB and GB (QA 2026-11-08). */
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
const UNIT_BASE = 1024;

export type ByteUnit = (typeof BYTE_UNITS)[number];

/** A byte count in its largest whole unit, rounded to one decimal: the parts a locale formats as it writes numbers. */
export function byteMagnitude(bytes: number): { value: number; unit: ByteUnit } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: 0, unit: 'B' };
  const index = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(UNIT_BASE)));
  return { value: Number.parseFloat((bytes / Math.pow(UNIT_BASE, index)).toFixed(1)), unit: BYTE_UNITS[index] };
}

const DISPLAY_UNITS: Record<ByteUnit, string> = { B: 'B', KiB: 'KB', MiB: 'MB', GiB: 'GB', TiB: 'TB' };

/** The unit a web page shows for a binary unit; the value stays a multiple of 1024. */
export function displayByteUnit(unit: ByteUnit): string {
  return DISPLAY_UNITS[unit];
}

export function formatBytes(bytes: number): string {
  const { value, unit } = byteMagnitude(bytes);
  return `${value} ${unit}`;
}

/** `formatBytes` for a web page: the same 1024 multiples, written as KB, MB and GB. */
export function formatBytesForDisplay(bytes: number): string {
  const { value, unit } = byteMagnitude(bytes);
  return `${value} ${displayByteUnit(unit)}`;
}
