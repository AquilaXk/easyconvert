/**
 * Pure Isomorphic Data Converter (Level 0 Fast-Path)
 *
 * Implements client-safe parsing and conversion across CSV, TSV, JSON, and YAML
 * with zero Node.js/native dependencies (strictly zero pdfkit or office imports).
 */

import Papa from 'papaparse';
import yaml from 'js-yaml';
import { detectDelimiter, nominalDelimiter, parseDelimitedRecords } from '../../conversions/delimited-detect';
import { FORMULA_TRIGGER } from '../../conversions/delimited-rules';

export interface PureDataResult {
  data: Uint8Array;
  text: string;
  mimeType: string;
  extension: string;
}

export interface PureDataOptions {
  delimiter?: string;
  escapeFormulas?: boolean;
}

const MAX_YAML_ALIAS_COUNT = 100;
const YAML_EXPANSION_FACTOR = 10;
const YAML_MIN_EXPANDED_VALUES = 100_000;
const MAX_YAML_DEPTH = 128;

function assertBoundedYamlExpansion(root: unknown, maxValues: number): void {
  const stack: Array<{ node: unknown; depth: number; ancestors: Set<object> }> = [
    { node: root, depth: 0, ancestors: new Set() },
  ];
  let expanded = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    expanded++;
    if (expanded > maxValues) {
      throw new Error(`alias expansion exceeds value limit (${maxValues})`);
    }
    const { node, depth, ancestors } = frame;
    if (typeof node !== 'object' || node === null) continue;
    if (ancestors.has(node)) {
      throw new Error('circular alias reference detected');
    }
    if (depth >= MAX_YAML_DEPTH) {
      throw new Error(`nesting depth exceeds limit (${MAX_YAML_DEPTH})`);
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node);
    const children = Array.isArray(node) ? node : Object.values(node);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], depth: depth + 1, ancestors: nextAncestors });
    }
  }
}

function loadBoundedYaml(textContent: string): unknown {
  let aliases = 0;
  let sourceNodes = 0;
  const loaded = yaml.load(textContent, {
    listener(op, state) {
      if (op !== 'open') return;
      sourceNodes++;
      if (state.input.charCodeAt(state.position) === 0x2a) {
        aliases++;
        if (aliases > MAX_YAML_ALIAS_COUNT) {
          throw new Error(`alias count exceeds limit (${MAX_YAML_ALIAS_COUNT})`);
        }
      }
    },
  });
  if (aliases > 0) {
    const maxExpanded = Math.max(YAML_MIN_EXPANDED_VALUES, sourceNodes * YAML_EXPANSION_FACTOR);
    assertBoundedYamlExpansion(loaded, maxExpanded);
  }
  return loaded;
}

function unparseDelimited(
  arrayData: Record<string, unknown>[],
  delimiter: string,
  options: PureDataOptions
): string {
  return Papa.unparse(arrayData, {
    delimiter,
    escapeFormulae: options.escapeFormulas === false ? false : FORMULA_TRIGGER,
  });
}

const SUPPORTED_DATA_SOURCES = new Set(['csv', 'tsv', 'tab', 'json', 'yaml', 'yml']);
const SUPPORTED_DATA_TARGETS = new Set(['csv', 'tsv', 'tab', 'json', 'yaml', 'yml', 'txt']);

const MIME_MAP: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  tab: 'text/tab-separated-values',
  json: 'application/json',
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  txt: 'text/plain',
};

/**
 * Checks whether the source and target formats are supported by the pure data engine.
 */
export function isPureDataConvertible(sourceFormat: string, targetFormat: string): boolean {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  return SUPPORTED_DATA_SOURCES.has(src) && SUPPORTED_DATA_TARGETS.has(tgt);
}

/**
 * Executes isomorphic zero-dependency conversion between structured data formats.
 */
export function convertPureData(
  input: string | Uint8Array,
  sourceFormat: string,
  targetFormat: string,
  options: PureDataOptions = {}
): PureDataResult {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  if (!isPureDataConvertible(src, tgt)) {
    throw new Error(`Pure data engine does not support conversion from '${src}' to '${tgt}'.`);
  }

  const textContent =
    typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);

  let intermediate: unknown;

  // 1. Ingest input into normalized JavaScript structure
  if (src === 'csv' || src === 'tsv' || src === 'tab') {
    // The server's reader: the same delimiter detection, own-property records, header renaming
    // and fail-closed DataParseError for any quote or field-count problem.
    const delimiter = options.delimiter ?? detectDelimiter(textContent, nominalDelimiter(src));
    intermediate = parseDelimitedRecords(textContent, delimiter, src).records;
  } else if (src === 'json') {
    try {
      intermediate = JSON.parse(textContent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Invalid JSON';
      throw new Error(`JSON parsing failed: ${msg}`);
    }
  } else if (src === 'yaml' || src === 'yml') {
    try {
      intermediate = loadBoundedYaml(textContent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Invalid YAML';
      throw new Error(`YAML parsing failed: ${msg}`);
    }
  } else {
    throw new Error(`Unsupported source data format: ${src}`);
  }

  // 2. Serialize intermediate structure to target format
  let outputText = '';
  if (tgt === 'json') {
    outputText = JSON.stringify(intermediate ?? {}, null, 2);
  } else if (tgt === 'yaml' || tgt === 'yml') {
    outputText = yaml.dump(intermediate ?? {});
  } else if (tgt === 'csv' || tgt === 'tsv' || tgt === 'tab') {
    const targetDelim = tgt === 'tsv' || tgt === 'tab' ? '\t' : ',';
    let arrayData: Record<string, unknown>[];
    if (Array.isArray(intermediate)) {
      arrayData = intermediate.map((item) =>
        typeof item === 'object' && item !== null
          ? (item as Record<string, unknown>)
          : { value: item }
      );
    } else if (typeof intermediate === 'object' && intermediate !== null) {
      arrayData = [intermediate as Record<string, unknown>];
    } else if (intermediate !== undefined) {
      arrayData = [{ value: intermediate }];
    } else {
      arrayData = [];
    }
    outputText = unparseDelimited(arrayData, targetDelim, options);
  } else if (tgt === 'txt') {
    outputText =
      typeof intermediate === 'string'
        ? intermediate
        : JSON.stringify(intermediate ?? '', null, 2);
  } else {
    throw new Error(`Unsupported target data format: ${tgt}`);
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(outputText);
  const mimeType = MIME_MAP[tgt] || 'text/plain';

  return {
    data,
    text: outputText,
    mimeType,
    extension: tgt === 'tab' ? 'tsv' : tgt,
  };
}
