import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { ParquetCodecUnavailableError } from '../src/lib/conversions/parquet-format';
import {
  ArchiveEncryptionUnavailableError,
  CadGeometryUnavailableError,
  ComplexScriptRequiresNativeEngineError,
  ConversionFailedError,
  EngineMissingError,
  EngineUnavailableError,
  OcrEngineUnavailableError,
  OcrLanguageUnavailableError,
  RawEngineRequiredError,
  UnsupportedOptionError,
} from '../src/lib/types';

const SOURCE_ROOT = path.resolve(__dirname, '..', 'src');
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** Names that say "a tool, binary, codec or engine is missing here", written down independently of the code. */
const MISSING_TOOL_NAME = /(Unavailable|Required|NotInstalled)\w*Error$|^Missing(Engine|Binary|Tool)\w*Error$/;
/** Typed errors whose name matches but that are about the caller's data or storage, not the worker. */
const NOT_ABOUT_THE_WORKER = new Set([
  'StorageProviderUnavailableError',
  'ArchivePasswordRequiredError',
  // A webhook secret request that names no target: a 400 about the caller, not a missing tool.
  'WebhookTargetRequiredError',
  // The browser offers no OPFS sync access handle: an internal signal to use the in-memory route.
  'SyncAccessUnavailableError',
]);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Every `class X extends Y` of the source tree, as a map from X to Y. */
function declaredClasses(): Map<string, { parent: string; file: string }> {
  const classes = new Map<string, { parent: string; file: string }>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    for (const match of fs.readFileSync(file, 'utf-8').matchAll(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)\s+extends\s+(\w+)/gm)) {
      classes.set(match[1], { parent: match[2], file: path.relative(SOURCE_ROOT, file) });
    }
  }
  return classes;
}

function descendsFrom(name: string, ancestor: string, classes: Map<string, { parent: string }>): boolean {
  const seen = new Set<string>();
  for (let current = name; current !== undefined && !seen.has(current); current = classes.get(current)?.parent as string) {
    if (current === ancestor) return true;
    seen.add(current);
  }
  return false;
}

describe('every missing-engine error shares one marker, which makes a job retryable', () => {
  it.each([
    ['EngineUnavailableError', new EngineUnavailableError('soffice'), HTTP_SERVICE_UNAVAILABLE],
    ['OcrEngineUnavailableError', new OcrEngineUnavailableError('tesseract missing'), HTTP_BAD_REQUEST],
    ['OcrLanguageUnavailableError', new OcrLanguageUnavailableError('traineddata missing'), HTTP_BAD_REQUEST],
    ['RawEngineRequiredError', new RawEngineRequiredError('native RAW decoder required'), HTTP_BAD_REQUEST],
    ['CadGeometryUnavailableError', new CadGeometryUnavailableError('CAD kernel missing'), HTTP_BAD_REQUEST],
    ['ComplexScriptRequiresNativeEngineError', new ComplexScriptRequiresNativeEngineError(), HTTP_BAD_REQUEST],
    ['ArchiveEncryptionUnavailableError', new ArchiveEncryptionUnavailableError('7z binary required'), HTTP_BAD_REQUEST],
    ['ParquetCodecUnavailableError', new ParquetCodecUnavailableError('ZSTD needs a newer Node.js'), HTTP_BAD_REQUEST],
  ])('%s is an EngineMissingError and is retried', (name, error, status) => {
    expect(error).toBeInstanceOf(EngineMissingError);
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(classifyJobFailure(error)).toEqual({ code: name, status, retryable: true });
  });

  it('keeps a verdict on the input final', () => {
    expect(classifyJobFailure(new UnsupportedOptionError('width 0')).retryable).toBe(false);
    expect(classifyJobFailure(new ConversionFailedError('bad input')).retryable).toBe(false);
  });

  it('finds no error class named like a missing tool anywhere in src that is not an EngineMissingError', () => {
    const classes = declaredClasses();
    const named = [...classes.keys()].filter((name) => MISSING_TOOL_NAME.test(name) && !NOT_ABOUT_THE_WORKER.has(name));
    // The scan itself must see the classes this test knows about, or it would pass by finding nothing.
    expect(named).toEqual(expect.arrayContaining(['EngineUnavailableError', 'ParquetCodecUnavailableError', 'ArchiveEncryptionUnavailableError']));
    const unmarked = named.filter((name) => !descendsFrom(name, 'EngineMissingError', classes));
    expect(unmarked).toEqual([]);
  });
});
