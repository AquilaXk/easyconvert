import { describe, it, expect } from 'vitest';
import { isPureDataConvertible } from '../src/lib/edge/pure/pure-data';
import { resolveConversionTier } from '../src/lib/edge/tier-router';
import { FORMAT_REGISTRY } from '../src/lib/registry';

/**
 * Structured-data conversions run on the server data engine, which detects encodings and
 * delimiters, escapes formulas, writes the CSV BOM, keeps big integers exact and caps YAML/XML
 * expansion. The browser fast path does none of that, so the router must not choose it.
 */

// Hand-written: the data formats the server engine (src/lib/conversions/data.ts) reads.
const DATA_SOURCES = ['csv', 'tsv', 'tab', 'json', 'ndjson', 'jsonl', 'yaml', 'yml', 'xml', 'toml'];
// Targets the server engine writes as text; office and PDF targets are other engines' concern.
const DATA_TEXT_TARGETS = new Set(['csv', 'tsv', 'tab', 'json', 'ndjson', 'jsonl', 'yaml', 'yml', 'xml', 'toml', 'txt']);
const SMALL_FILE_BYTES = 4096;

describe('structured-data conversions are routed to the server engine', () => {
  const pairs = DATA_SOURCES.flatMap((source) =>
    FORMAT_REGISTRY[source].targetFormats.filter((target) => DATA_TEXT_TARGETS.has(target)).map((target) => [source, target] as const)
  );

  it('covers every advertised data-to-data pair', () => {
    expect(pairs).toContainEqual(['csv', 'json']);
    expect(pairs).toContainEqual(['json', 'csv']);
    expect(pairs).toContainEqual(['yaml', 'json']);
    expect(pairs).toContainEqual(['toml', 'yaml']);
    expect(pairs.length).toBeGreaterThanOrEqual(30);
  });

  it('includes the pairs the browser data module can convert, so routing is what keeps them off it', () => {
    const moduleCapable = pairs.filter(([source, target]) => isPureDataConvertible(source, target));
    expect(moduleCapable).toContainEqual(['csv', 'json']);
    expect(moduleCapable).toContainEqual(['yaml', 'json']);
  });

  it('resolves every data pair of a small file to the cloud tier', () => {
    const onClient = pairs
      .map(([source, target]) => ({ pair: `${source}->${target}`, resolution: resolveConversionTier(source, target, SMALL_FILE_BYTES) }))
      .filter(({ resolution }) => resolution.isClientEdge)
      .map(({ pair, resolution }) => `${pair}: ${resolution.tier}`);
    expect(onClient).toEqual([]);
    expect(resolveConversionTier('csv', 'json', SMALL_FILE_BYTES)).toMatchObject({ tier: 'L4', isClientEdge: false });
  });
});
