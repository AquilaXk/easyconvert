import { describe, expect, it } from 'vitest';
import { unconvertibleReason } from '../src/components/workbench/queue-item-convertibility';
import { TOOL_GROUP_BY_KEY, TOOL_GROUPS } from '../src/components/site-links';

const MAX = 100 * 1024 * 1024;

describe('unconvertibleReason', () => {
  it('names the first reason that applies, and none for a file that converts', () => {
    expect(unconvertibleReason({ size: MAX + 1, sourceFormat: 'png' }, MAX)).toBe('oversize');
    expect(unconvertibleReason({ size: 0, sourceFormat: 'png' }, MAX)).toBe('empty');
    expect(unconvertibleReason({ size: 10, sourceFormat: 'not-a-format' }, MAX)).toBe('unsupported');
    expect(unconvertibleReason({ size: 10, sourceFormat: '' }, MAX)).toBe('unsupported');
    expect(unconvertibleReason({ size: 10, sourceFormat: 'png' }, MAX)).toBeNull();
    expect(unconvertibleReason({ size: MAX, sourceFormat: 'png' }, MAX)).toBeNull();
  });

  it('puts an oversize file that has no format under oversize, as the queue row did', () => {
    expect(unconvertibleReason({ size: MAX + 1, sourceFormat: 'not-a-format' }, MAX)).toBe('oversize');
  });
});

describe('TOOL_GROUP_BY_KEY', () => {
  it('holds every tool group under its own key', () => {
    expect(Object.keys(TOOL_GROUP_BY_KEY).sort()).toEqual(TOOL_GROUPS.map((group) => group.key).sort());
    for (const group of TOOL_GROUPS) expect(TOOL_GROUP_BY_KEY[group.key]).toBe(group);
    expect(TOOL_GROUP_BY_KEY.websiteCapture.links.length).toBeGreaterThan(0);
  });
});
