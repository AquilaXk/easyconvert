import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import { refusalCodeOf, type ConversionRefusalCode } from '../src/lib/refusal-codes';

/**
 * Every error class a conversion can throw names its cause by a `refusalCode` it declares or inherits: the subclasses of
 * ConversionFailedError and the other classes that declare one, found by scanning src. The table is the code each class
 * answers, written out, so a new class or a changed parent fails here until the table names what the class answers.
 */

const SRC = path.resolve(__dirname, '..', 'src');

const EXPECTED_CODES: Record<string, ConversionRefusalCode> = {
  ArchiveEntryCollisionError: 'archive_entry_collision',

  ArchiveNotEncryptedError: 'conversion_failed',
  AudioResampleError: 'conversion_failed',
  AvifEncoderFailedError: 'conversion_failed',
  BmpDecodeError: 'conversion_failed',
  CadGeometryError: 'conversion_failed',
  CffCharStringError: 'conversion_failed',
  CffFormatError: 'conversion_failed',
  ColourTagError: 'conversion_failed',
  ConversionFailedError: 'conversion_failed',
  CpuTaskAbortedError: 'conversion_failed',
  DataRepresentationError: 'conversion_failed',
  DjvuComponentSizeError: 'conversion_failed',
  DjvuIncludeStructureError: 'conversion_failed',
  DocumentFormatError: 'conversion_failed',
  EdgeStorageQuotaError: 'conversion_failed',
  EdgeUnsupportedError: 'conversion_failed',
  FlacInputError: 'conversion_failed',
  FontCoverageError: 'conversion_failed',
  FontOutlinesMissingError: 'conversion_failed',
  GraphExportError: 'conversion_failed',
  GraphStateCorruptError: 'conversion_failed',
  IccProfileError: 'conversion_failed',
  IcnsDecodeError: 'conversion_failed',
  IcoDecodeError: 'conversion_failed',
  InvalidConversionOutputError: 'conversion_failed',
  InvalidRawSensorError: 'conversion_failed',
  InvalidSheetIndexError: 'conversion_failed',
  InvalidUnicodeTextError: 'conversion_failed',
  LegacyOfficeFormatError: 'conversion_failed',
  LoudnessMeasurementError: 'conversion_failed',
  MacFontContainerError: 'conversion_failed',
  MarkdownSanitizationError: 'conversion_failed',
  NoAudioStreamError: 'conversion_failed',
  NoVideoStreamError: 'conversion_failed',
  OcrMarkupError: 'conversion_failed',
  OcrPreprocessError: 'conversion_failed',
  OpenExrDecodeError: 'conversion_failed',
  ParquetFormatError: 'conversion_failed',
  ParquetUnsupportedError: 'conversion_failed',
  ParquetValueError: 'conversion_failed',
  PdfLayoutLimitError: 'conversion_failed',
  PdfPageFrameError: 'conversion_failed',
  PdfStructureError: 'conversion_failed',
  PdfTextGeometryError: 'conversion_failed',
  PdfTextUnmappedError: 'conversion_failed',
  RawDecodeError: 'conversion_failed',
  RocketBookFormatError: 'conversion_failed',
  RtfHoldsNoTextError: 'conversion_failed',
  SvgFontFormatError: 'conversion_failed',
  SvgPathDataError: 'conversion_failed',
  SvgSanitizationError: 'conversion_failed',
  TooManyMediaStreamsError: 'conversion_failed',
  UnknownArtifactFormatError: 'conversion_failed',
  UnsupportedMobiEncodingError: 'conversion_failed',
  UnsupportedRawCompressionError: 'conversion_failed',
  WatermarkFontError: 'conversion_failed',
  Woff2FormatError: 'conversion_failed',
  WorkerOutputMissingError: 'conversion_failed',

  EmptyAudioInputError: 'empty_file',

  ArchiveEncryptedHeaderError: 'encrypted_input',
  EncryptedOfficeDocumentError: 'encrypted_input',
  PdfPasswordListError: 'encrypted_input',
  PdfPermissionDeniedError: 'encrypted_input',
  SuiteEncryptedDocumentError: 'encrypted_input',

  ArchiveEncryptionUnavailableError: 'engine_unavailable',
  CadGeometryUnavailableError: 'engine_unavailable',
  ComplexScriptRequiresNativeEngineError: 'engine_unavailable',
  CpuPoolOverloadedError: 'engine_unavailable',
  EngineMissingError: 'engine_unavailable',
  EngineUnavailableError: 'engine_unavailable',
  NativeRenameUnsupportedError: 'engine_unavailable',
  OcrEngineUnavailableError: 'engine_unavailable',
  OcrGeometryUnavailableError: 'engine_unavailable',
  OcrLanguageUnavailableError: 'engine_unavailable',
  OcrTextLayerLimitError: 'engine_unavailable',
  ParquetCodecUnavailableError: 'engine_unavailable',
  QueueUnavailableError: 'engine_unavailable',
  RawEngineRequiredError: 'engine_unavailable',
  SandboxUnavailableError: 'engine_unavailable',

  CadExpansionLimitError: 'input_over_limit',
  DataLimitExceededError: 'input_over_limit',
  DecompressionLimitError: 'input_over_limit',
  InputPixelLimitError: 'input_over_limit',
  OcrWorkLimitError: 'input_over_limit',
  PayloadLimitError: 'input_over_limit',
  ShapingLimitError: 'input_over_limit',
  SheetLimitError: 'input_over_limit',
  Woff2LimitError: 'input_over_limit',

  InvalidPageRangeError: 'invalid_pages',

  InvalidArchivePasswordError: 'invalid_password',

  CompoundFileStructureError: 'malformed_input',
  CorruptStreamError: 'malformed_input',
  DataEncodingError: 'malformed_input',
  DataParseError: 'malformed_input',
  MediaProbeError: 'malformed_input',
  SevenZipStructureError: 'malformed_input',
  UnopenableArchiveError: 'malformed_input',
  UnprocessableFontInputError: 'malformed_input',
  UnreadableArchiveError: 'malformed_input',

  MissingVolumeError: 'missing_volume',

  InvalidMediaOptionError: 'option_not_supported',
  UnsupportedOptionError: 'option_not_supported',

  ArchivePasswordRequiredError: 'password_required',
  PdfPasswordRequiredError: 'password_required',

  FileExtensionSpoofError: 'spoofed_file',

  CpuTaskTimeoutError: 'timeout',
  DjvuDrawTimeoutError: 'timeout',
  JobTimeoutError: 'timeout',

  UnsafeArchiveError: 'unsafe_archive',

  ArchiveInputUnprocessableError: 'unsupported_input',
  RefusedMediaInputError: 'unsupported_input',
  UnprocessableCadInputError: 'unsupported_input',
  UnprocessableMediaInputError: 'unsupported_input',
  UnsupportedDwgVersionError: 'unsupported_input',
  UnsupportedMediaCodecError: 'unsupported_input',

  UnsupportedArchiveMethodError: 'unsupported_method',

  UnsupportedTargetError: 'unsupported_pair',
};

interface ScannedClass {
  file: string;
  parent: string;
  exported: boolean;
  declaresCode: boolean;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

const CLASS_DECLARATION = /^(export )?class (\w+) extends (\w+)[^{]*\{([\s\S]*?)^\}/gm;

function scanClasses(): Map<string, ScannedClass> {
  const classes = new Map<string, ScannedClass>();
  for (const file of sourceFiles(SRC)) {
    for (const match of fs.readFileSync(file, 'utf-8').matchAll(CLASS_DECLARATION)) {
      classes.set(match[2], { file, parent: match[3], exported: match[1] !== undefined, declaresCode: /\brefusalCode\b/.test(match[4]) });
    }
  }
  return classes;
}

const classes = scanClasses();

function isCoded(name: string): boolean {
  if (name === 'ConversionFailedError') return true;
  const scanned = classes.get(name);
  return scanned !== undefined && (scanned.declaresCode || isCoded(scanned.parent));
}

const CODED = [...classes.keys()].filter(isCoded).sort();

/** Arguments one of the constructors of these classes accepts: a message, names, numbers or a page list. */
const CONSTRUCTOR_ARGUMENTS: unknown[][] = [['x'], ['x', 'x'], ['x', 'x', 'x'], [1, 1, 1], [[1]], []];

async function instanceOf(name: string, scanned: ScannedClass): Promise<Error> {
  const exports = (await import(scanned.file)) as Record<string, new (...args: unknown[]) => Error>;
  for (const args of CONSTRUCTOR_ARGUMENTS) {
    try {
      return new exports[name](...args);
    } catch {
      // A constructor that needs another form of arguments.
    }
  }
  throw new Error(`${name} accepts none of the argument forms`);
}

describe('every coded error class answers the code the table names', () => {
  it('the table lists exactly the coded classes in src', () => {
    expect(CODED).toEqual(Object.keys(EXPECTED_CODES).sort());
  });

  it.each(CODED.filter((name) => classes.get(name)?.exported))('%s', async (name) => {
    expect(refusalCodeOf(await instanceOf(name, classes.get(name)!))).toBe(EXPECTED_CODES[name]);
  });

  it.each(CODED.filter((name) => !classes.get(name)?.exported))('%s, a module-local class, inherits the code of its parent', (name) => {
    const scanned = classes.get(name)!;
    expect(scanned.declaresCode).toBe(false);
    expect(EXPECTED_CODES[name]).toBe(EXPECTED_CODES[scanned.parent]);
  });
});

describe('every problem type the server sends has a sentence', () => {
  const PROBLEM_NAME = /(?:problems\/|PROBLEM_TYPE_BASE\})([a-z][a-z0-9-]*)/g;
  const serverFiles = [...sourceFiles(path.join(SRC, 'app')), ...sourceFiles(path.join(SRC, 'lib')), path.join(SRC, 'middleware.ts')];
  const sent = [...new Set(serverFiles.flatMap((file) => [...fs.readFileSync(file, 'utf-8').matchAll(PROBLEM_NAME)].map((match) => match[1])))].sort();

  it('finds the problem types of the shared helpers and of the conversion errors', () => {
    expect(sent).toEqual(expect.arrayContaining(['payload-too-large', 'engine-unavailable', 'missing-archive-volume']));
  });

  it.each(sent)('%s', (name) => {
    expect(Object.hasOwn(en.errors.problems, name)).toBe(true);
  });
});
