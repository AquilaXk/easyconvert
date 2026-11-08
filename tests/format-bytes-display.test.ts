import { describe, expect, it } from 'vitest';
import { displayByteUnit, formatBytes, formatBytesForDisplay } from '../src/lib/format-bytes';
import { fileTooLargeMessage } from '../src/lib/plan-limits';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

describe('byte sizes on web pages and on the API', () => {
  it('shows the 1024 multiples as KB, MB and GB on a page', () => {
    expect(formatBytesForDisplay(1024)).toBe('1 KB');
    expect(formatBytesForDisplay(30 * MIB)).toBe('30 MB');
    expect(formatBytesForDisplay(GIB)).toBe('1 GB');
    expect(formatBytesForDisplay(1.5 * GIB)).toBe('1.5 GB');
    expect(formatBytesForDisplay(0)).toBe('0 B');
    expect(displayByteUnit('TiB')).toBe('TB');
  });

  it('keeps the IEC names for the API, logs and OpenAPI', () => {
    expect(formatBytes(GIB)).toBe('1 GiB');
    expect(formatBytes(30 * MIB)).toBe('30 MiB');
    expect(fileTooLargeMessage('free', 3 * GIB)).toBe('File size 3 GiB exceeds the 1 GiB limit for the free plan.');
  });
});
