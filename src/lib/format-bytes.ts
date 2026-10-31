/** Binary multiples, so they carry the IEC names: a 1 GiB limit reads "1 GiB", never "1 GB". */
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
const UNIT_BASE = 1024;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const index = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(UNIT_BASE)));
  return `${Number.parseFloat((bytes / Math.pow(UNIT_BASE, index)).toFixed(1))} ${BYTE_UNITS[index]}`;
}
