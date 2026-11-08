import fs from 'node:fs';
import { readCompoundFileRootFrom, type ByteSource } from '../../compound-file-kind';
import { officeImportFilterArgs } from './office-suite-sources';
import { readCfbStreams } from './cfb-streams';
import { LegacyOfficeFormatError } from './legacy-office-errors';

/**
 * The import filter of the office suite for the legacy binary Office formats and the Palm text databases. The suite has one filter for each
 * generation of these formats behind one extension (`registry/*.xcd` of the installation: `MS Word 97`, `MS Word 95`, `MS WinWord 6.0`,
 * `MS Excel 97`, `MS Excel 5.0/95`, `MS PowerPoint 97`, `Palm_Text_Document`, `Plucker eBook`), and a file of another generation is refused by the
 * filter of the newest, so the generation is read from the file itself (the way the suite's own type detection reads it) and the filter
 * of that generation is named. A file whose generation is not recognised gets no filter and is opened by the suite's type detection, as it was.
 */

const WORD_97_CLASS_ID = '00020906-0000-0000-C000-000000000046';
/** [MS-DOC] 2.5.1: `nFib` of Word 97 and later; Word 95 wrote 104 and Word 6.0 wrote 101 ([MS-DOC] 2.9.76, the `nFib` table of the Word 6 and 95 binary format). */
const WORD_97_FIRST_NFIB = 0xc1;
const WORD_95_NFIB = 104;
const WORD_6_NFIB = 101;
/** The `nFib` field of the `FIB` that starts the `WordDocument` stream, after the 2-byte `wIdent`. */
const NFIB_OFFSET = 2;
const WORD_IDENT = 0xa5ec;
const WORD_DOCUMENT_STREAM = 'WordDocument';

/** Offsets of the Palm database header ([PalmOS File Formats] `PDB`): database type and creator, 8 bytes at 60. */
const PDB_TYPE_OFFSET = 60;
const PDB_TYPE_CREATOR_BYTES = 8;
const PDB_FILTER_BY_TYPE_CREATOR: Readonly<Record<string, string>> = {
  TEXtREAd: 'Palm_Text_Document',
  DataPlkr: 'Plucker eBook',
};

interface Generations {
  /** The filter of the plain document and the filter of its template or slide show, when the suite has one. */
  readonly document: string;
  readonly template?: string;
  readonly slideShow?: string;
}

const WORD_97: Generations = { document: 'MS Word 97', template: 'MS Word 97 Vorlage' };
const WORD_95: Generations = { document: 'MS Word 95', template: 'MS Word 95 Vorlage' };
const WORD_6: Generations = { document: 'MS WinWord 6.0' };
const EXCEL_97: Generations = { document: 'MS Excel 97', template: 'MS Excel 97 Vorlage/Template' };
const EXCEL_5_95: Generations = { document: 'MS Excel 5.0/95', template: 'MS Excel 5.0/95 Vorlage/Template' };
const POWERPOINT_97: Generations = { document: 'MS PowerPoint 97', template: 'MS PowerPoint 97 Vorlage', slideShow: 'MS PowerPoint 97 AutoPlay' };

/** Every filter name this module can choose, for the check against the registry of the installed suite. */
export const LEGACY_IMPORT_FILTER_NAMES: readonly string[] = [
  ...[WORD_97, WORD_95, WORD_6, EXCEL_97, EXCEL_5_95, POWERPOINT_97].flatMap((generations) => [generations.document, generations.template, generations.slideShow]),
  ...Object.values(PDB_FILTER_BY_TYPE_CREATOR),
].filter((name): name is string => name !== undefined);

/** The filter of a generation for the extension of the file: the template and slide show filters belong to the extensions of those files. */
function filterOf(generations: Generations, format: string): string | undefined {
  if (format === 'dot' || format === 'xlt' || format === 'pot') return generations.template;
  if (format === 'pps') return generations.slideShow;
  return generations.document;
}

/** The `WordDocument` stream of the file, or undefined when no reader can open the compound file (the suite is then left to detect it, and refuses it as before). */
function wordDocumentStream(inputPath: string): Buffer | undefined {
  try {
    return readCfbStreams(fs.readFileSync(inputPath), inputPath).get(WORD_DOCUMENT_STREAM);
  } catch (error) {
    if (error instanceof LegacyOfficeFormatError) return undefined;
    throw error;
  }
}

function wordGeneration(classId: string | undefined, inputPath: string): Generations | undefined {
  if (classId === WORD_97_CLASS_ID) return WORD_97;
  // The class ID of a Word 6.0 or 95 file is the same, so the version is the `nFib` of the document stream.
  const stream = wordDocumentStream(inputPath);
  if (stream === undefined || stream.length < NFIB_OFFSET + 2 || stream.readUInt16LE(0) !== WORD_IDENT) return undefined;
  const nFib = stream.readUInt16LE(NFIB_OFFSET);
  if (nFib >= WORD_97_FIRST_NFIB) return WORD_97;
  if (nFib === WORD_95_NFIB) return WORD_95;
  return nFib === WORD_6_NFIB ? WORD_6 : undefined;
}

function compoundGeneration(format: string, source: ByteSource, inputPath: string): Generations | undefined {
  const root = readCompoundFileRootFrom(source);
  if (root.status !== 'read') return undefined;
  switch (format) {
    case 'doc':
    case 'dot':
      return root.names.has('WORDDOCUMENT') ? wordGeneration(root.classId, inputPath) : undefined;
    case 'xls':
    case 'xlt':
      // Excel 97 and later keep the workbook in `Workbook`, Excel 5.0 and 95 in `Book`.
      if (root.names.has('WORKBOOK')) return EXCEL_97;
      return root.names.has('BOOK') ? EXCEL_5_95 : undefined;
    case 'ppt':
    case 'pps':
    case 'pot':
      return root.names.has('POWERPOINT DOCUMENT') ? POWERPOINT_97 : undefined;
    default:
      return undefined;
  }
}

function palmFilter(source: ByteSource): string | undefined {
  const header = Buffer.from(source(PDB_TYPE_OFFSET, PDB_TYPE_CREATOR_BYTES));
  const typeAndCreator = header.toString('latin1');
  return header.length === PDB_TYPE_CREATOR_BYTES && Object.hasOwn(PDB_FILTER_BY_TYPE_CREATOR, typeAndCreator) ? PDB_FILTER_BY_TYPE_CREATOR[typeAndCreator] : undefined;
}

/** The formats whose import filter depends on the file: the Word, Excel and PowerPoint documents, templates and slide shows of the compound file, and the Palm databases. */
const GENERATION_DEPENDENT_FORMATS: ReadonlySet<string> = new Set(['doc', 'dot', 'xls', 'xlt', 'ppt', 'pps', 'pot', 'wps', 'pdb']);

/**
 * The import filter for the legacy binary Office or Palm file at `inputPath` declared as `format`, or undefined when its generation is not
 * recognised. A Works `.wps` is the Word 97 format only when it is a Word compound file; any other Works file is left to the type detection.
 */
export function legacyOfficeImportFilter(format: string, inputPath: string): string | undefined {
  const lower = format.toLowerCase();
  const fd = fs.openSync(inputPath, 'r');
  try {
    const source: ByteSource = (offset, length) => {
      const bytes = Buffer.alloc(length);
      return bytes.subarray(0, fs.readSync(fd, bytes, 0, length, offset));
    };
    if (lower === 'pdb') return palmFilter(source);
    // A `.wps` that is a Word compound file is read as the Word format; a Works file is not recognised.
    const word = lower === 'wps' ? 'doc' : lower;
    const generations = compoundGeneration(word, source, inputPath);
    return generations === undefined ? undefined : filterOf(generations, word);
  } finally {
    fs.closeSync(fd);
  }
}

/** The `soffice` arguments naming the import filter of the file at `inputPath` declared as `format`: the filter of its generation for a legacy format, else the one of the declared format (see officeImportFilterArgs). */
export function officeInputFilterArgs(format: string, inputPath: string): string[] {
  if (!GENERATION_DEPENDENT_FORMATS.has(format.toLowerCase())) return officeImportFilterArgs(format);
  const filter = legacyOfficeImportFilter(format, inputPath);
  return filter === undefined ? [] : [`--infilter=${filter}`];
}
