const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const UNIT_BASE = 1024;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const index = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(UNIT_BASE)));
  return `${Number.parseFloat((bytes / Math.pow(UNIT_BASE, index)).toFixed(1))} ${BYTE_UNITS[index]}`;
}
