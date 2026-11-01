/** Binary multiples, so they carry the IEC names: a 1 GiB limit reads "1 GiB", never "1 GB". */
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
const UNIT_BASE = 1024;

export type ByteUnit = (typeof BYTE_UNITS)[number];

/** A byte count in its largest whole unit, rounded to one decimal: the parts a locale formats as it writes numbers. */
export function byteMagnitude(bytes: number): { value: number; unit: ByteUnit } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: 0, unit: 'B' };
  const index = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(UNIT_BASE)));
  return { value: Number.parseFloat((bytes / Math.pow(UNIT_BASE, index)).toFixed(1)), unit: BYTE_UNITS[index] };
}

export function formatBytes(bytes: number): string {
  const { value, unit } = byteMagnitude(bytes);
  return `${value} ${unit}`;
}
