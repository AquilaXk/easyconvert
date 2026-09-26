/**
 * Pure Isomorphic Data Converter (Level 0 Fast-Path)
 *
 * Implements client-safe parsing and conversion across CSV, TSV, JSON, and YAML
 * with zero Node.js/native dependencies (strictly zero pdfkit or office imports).
 */

import Papa from 'papaparse';
import yaml from 'js-yaml';

export interface PureDataResult {
  data: Uint8Array;
  text: string;
  mimeType: string;
  extension: string;
}

export interface PureDataOptions {
  delimiter?: string;
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
    const delimiter =
      options.delimiter || (src === 'tsv' || src === 'tab' ? '\t' : ',');
    const parsed = Papa.parse(textContent, {
      header: true,
      skipEmptyLines: true,
      delimiter,
    });

    if (parsed.errors && parsed.errors.length > 0 && parsed.data.length === 0) {
      throw new Error(`Failed to parse ${src.toUpperCase()}: ${parsed.errors[0].message}`);
    }

    intermediate = parsed.data;
  } else if (src === 'json') {
    try {
      intermediate = JSON.parse(textContent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Invalid JSON';
      throw new Error(`JSON parsing failed: ${msg}`);
    }
  } else if (src === 'yaml' || src === 'yml') {
    try {
      intermediate = yaml.load(textContent);
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
    outputText = JSON.stringify(intermediate, null, 2);
  } else if (tgt === 'yaml' || tgt === 'yml') {
    outputText = yaml.dump(intermediate);
  } else if (tgt === 'csv' || tgt === 'tsv' || tgt === 'tab') {
    const targetDelim = tgt === 'tsv' || tgt === 'tab' ? '\t' : ',';
    const arrayData = Array.isArray(intermediate) ? intermediate : [intermediate];
    outputText = Papa.unparse(arrayData as Record<string, unknown>[], { delimiter: targetDelim });
  } else if (tgt === 'txt') {
    outputText =
      typeof intermediate === 'string'
        ? intermediate
        : JSON.stringify(intermediate, null, 2);
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
