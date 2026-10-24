import { inflateSync } from 'node:zlib';
import { ConversionFailedError } from '../../types';
import { CheckedReader, readCfbContainer, readCfbStreams, requireCfbStream } from './cfb-streams';
import { EncryptedOfficeDocumentError, LegacyOfficeFormatError } from './legacy-office-errors';
import { decodeWindows1252 } from './windows-1252';
import { isSymbolFontPrivateUse, mapSymbolFontCharacter, symbolReplacementWarning, undrawableSymbolWarning } from '../symbol-font-map';
import { readCharacterFontRuns, type CharacterFontRun } from './ppt-text-style';

/**
 * Text reader for PowerPoint 97-2003 binary presentations, written from [MS-PPT]. It follows the
 * Current User stream to the newest UserEditAtom, merges the persist directories of every edit, finds
 * the slides through the SlideListWithText of the document, and reads the TextCharsAtom and
 * TextBytesAtom text of each slide in shape order. Master, notes and deleted slides are not read. The objects a slide embeds
 * (the compound file of an OLE object such as a chart) are returned as they are stored, for the caller to read.
 */

const LABEL = 'PowerPoint presentation';
const DOCUMENT_STREAM = 'PowerPoint Document';
const CURRENT_USER_STREAM = 'Current User';

/** Most edit generations (UserEditAtom chain) that are followed. */
export const PPT_MAX_EDIT_CHAIN = 4096;
/** Most records the reader visits in one presentation. */
export const PPT_MAX_RECORDS = 2_000_000;
/** Deepest container nesting that is followed. */
export const PPT_MAX_RECORD_DEPTH = 64;
/** Most slides one presentation may list. */
export const PPT_MAX_SLIDES = 100_000;

// Record header ([MS-PPT] 2.3.1): recVer/recInstance (2 bytes), recType (2), recLen (4).
const RECORD_HEADER_BYTES = 8;
const REC_VER_MASK = 0x000f;
const REC_VER_CONTAINER = 0xf;
const REC_INSTANCE_SHIFT = 4;

const RT_DOCUMENT = 0x03e8;
const RT_ENVIRONMENT = 0x03f2;
const RT_FONT_COLLECTION = 0x07d5;
const RT_FONT_ENTITY_ATOM = 0x0fb7;
const RT_STYLE_TEXT_PROP_ATOM = 0x0fa1;
const RT_SLIDE = 0x03ee;
const RT_SLIDE_PERSIST_ATOM = 0x03f3;
const RT_SLIDE_LIST_WITH_TEXT = 0x0ff0;
const RT_USER_EDIT_ATOM = 0x0ff5;
const RT_CURRENT_USER_ATOM = 0x0ff6;
const RT_PERSIST_DIRECTORY_ATOM = 0x1772;
const RT_TEXT_HEADER_ATOM = 0x0f9f;
const RT_TEXT_CHARS_ATOM = 0x0fa0;
const RT_TEXT_BYTES_ATOM = 0x0fa8;
const RT_OUTLINE_TEXT_REF_ATOM = 0x0f9e;
const RT_CLIENT_TEXTBOX = 0xf00d;
const RT_EX_OBJ_LIST = 0x0409;
const RT_EX_EMBED = 0x0fcc;
const RT_EX_OLE_OBJ_ATOM = 0x0fc3;
const RT_EX_OLE_OBJ_STG = 0x1011;
const RT_EX_OBJ_REF_ATOM = 0x0bc1;
/** ExOleObjAtom ([MS-PPT] 2.10.12): the object's id on the slides, and the persist id of its storage. */
const EX_OLE_OBJ_ID_OFFSET = 8;
const EX_OLE_OBJ_PERSIST_OFFSET = 16;
const EX_OLE_OBJ_ATOM_MIN_BYTES = 20;
/** ExOleObjStg: a compressed storage (recInstance 1) starts with its uncompressed size, then a zlib stream. */
const EX_OLE_OBJ_STG_COMPRESSED = 1;
const EX_OLE_OBJ_STG_SIZE_BYTES = 4;
/** Largest embedded object that is inflated; the compound file of a chart is a few hundred kilobytes. */
export const PPT_MAX_EMBEDDED_OBJECT_BYTES = 64 * 1024 * 1024;
/** SlideNumber, DateTime, GenericDate, Header, Footer and RTFDateTime meta atoms mark one field character each. */
const META_ATOM_TYPES: ReadonlySet<number> = new Set([0x0fd8, 0x0ff7, 0x0ff8, 0x0ff9, 0x0ffa, 0x1015]);
/** SlideListWithTextContainer instance 0 lists the slides; 1 lists masters and 2 lists notes. */
const SLWT_INSTANCE_SLIDES = 0;

// CurrentUserAtom ([MS-PPT] 2.3.2).
const CURRENT_USER_TOKEN_OFFSET = 12;
const CURRENT_USER_EDIT_OFFSET = 16;
const HEADER_TOKEN_PLAIN = 0xe391c05f;
const HEADER_TOKEN_ENCRYPTED = 0xf3d1c4df;

// UserEditAtom ([MS-PPT] 2.3.3), offsets from the start of the record.
const USER_EDIT_LAST_EDIT_OFFSET = 16;
const USER_EDIT_PERSIST_DIRECTORY_OFFSET = 20;
const USER_EDIT_DOC_PERSIST_ID_OFFSET = 24;
const USER_EDIT_PERSIST_ID_SEED_OFFSET = 28;
const USER_EDIT_ENCRYPT_SESSION_OFFSET = 36;
const USER_EDIT_BASE_LENGTH = 28;
const USER_EDIT_ENCRYPTED_LENGTH = 32;

// PersistDirectoryEntry: persistId in the low 20 bits and the entry count in the high 12 bits.
const PERSIST_ID_MASK = 0x000fffff;
const PERSIST_COUNT_SHIFT = 20;
const UINT32_BYTES = 4;

const SLIDE_PERSIST_REF_OFFSET = 8;
const OUTLINE_REF_INDEX_OFFSET = 8;

const CH_PARAGRAPH_END = 0x0d;
const CH_LINE_BREAK = 0x0b;
const CH_TAB = 0x09;
const FIELD_PLACEHOLDER = '*';
const FIRST_PRINTABLE = 0x20;
/** A FontEntityAtom starts with the face name: 32 UTF-16 code units, zero padded. */
const FONT_FACE_NAME_BYTES = 64;
const REPLACEMENT_CHARACTER = '\uFFFD';
/** Most replaced symbol characters listed one by one; the rest are counted in a final line. */
export const PPT_MAX_REPORTED_REPLACEMENTS = 50;

interface RecordHeader {
  offset: number;
  recVer: number;
  recInstance: number;
  recType: number;
  recLen: number;
  /** Offset of the first byte after the record body. */
  end: number;
}

interface TextBlock {
  text: string;
  metaPositions: number[];
  /** Font references per stretch of text, or null when the block has no readable StyleTextPropAtom. */
  fontRuns: CharacterFontRun[] | null;
}

export interface PptSlide {
  /** 1-based position in the presentation. */
  number: number;
  /** Paragraphs of every text shape of the slide, in shape order; empty paragraphs are dropped. */
  texts: string[];
  /** The compound files of the objects the slide embeds (charts), in shape order. */
  embedded: Buffer[];
}

class RecordBudget {
  private visited = 0;

  count(): void {
    this.visited++;
    if (this.visited > PPT_MAX_RECORDS) {
      throw new LegacyOfficeFormatError(`${LABEL}: the presentation holds more than ${PPT_MAX_RECORDS} records.`);
    }
  }
}

function readHeader(reader: CheckedReader, offset: number, limit: number): RecordHeader {
  if (offset + RECORD_HEADER_BYTES > limit) {
    throw new LegacyOfficeFormatError(`${LABEL}: a record header at offset ${offset} runs past its parent.`);
  }
  const versionAndInstance = reader.u16(offset);
  const recLen = reader.u32(offset + 4);
  const end = offset + RECORD_HEADER_BYTES + recLen;
  if (end > limit) {
    throw new LegacyOfficeFormatError(`${LABEL}: the record at offset ${offset} is longer than its parent.`);
  }
  return {
    offset,
    recVer: versionAndInstance & REC_VER_MASK,
    recInstance: versionAndInstance >> REC_INSTANCE_SHIFT,
    recType: reader.u16(offset + 2),
    recLen,
    end,
  };
}

/** The children of a container record, in order. */
function readChildren(reader: CheckedReader, parent: RecordHeader, budget: RecordBudget): RecordHeader[] {
  const children: RecordHeader[] = [];
  let at = parent.offset + RECORD_HEADER_BYTES;
  while (at < parent.end) {
    budget.count();
    const child = readHeader(reader, at, parent.end);
    children.push(child);
    at = child.end;
  }
  return children;
}

interface EditChain {
  /** persistId -> byte offset in the PowerPoint Document stream; the newest definition wins. */
  persist: Map<number, number>;
  docPersistId: number;
  /** Offset of the newest UserEditAtom, the one the Current User stream names. */
  newestEditOffset: number;
}

function readPersistDirectory(reader: CheckedReader, offset: number, into: Map<number, number>): void {
  const header = readHeader(reader, offset, reader.length);
  if (header.recType !== RT_PERSIST_DIRECTORY_ATOM) {
    throw new LegacyOfficeFormatError(`${LABEL}: the persist directory at offset ${offset} has record type 0x${header.recType.toString(16)}.`);
  }
  let at = offset + RECORD_HEADER_BYTES;
  while (at < header.end) {
    if (at + UINT32_BYTES > header.end) {
      throw new LegacyOfficeFormatError(`${LABEL}: a persist directory entry is cut off.`);
    }
    const head = reader.u32(at);
    const firstId = head & PERSIST_ID_MASK;
    const count = head >>> PERSIST_COUNT_SHIFT;
    at += UINT32_BYTES;
    if (at + count * UINT32_BYTES > header.end) {
      throw new LegacyOfficeFormatError(`${LABEL}: a persist directory entry lists more offsets than the record holds.`);
    }
    for (let i = 0; i < count; i++) {
      const id = firstId + i;
      if (!into.has(id)) into.set(id, reader.u32(at));
      at += UINT32_BYTES;
    }
  }
}

function readEditChain(current: CheckedReader, document: CheckedReader): EditChain {
  const token = current.u32(CURRENT_USER_TOKEN_OFFSET);
  if (token === HEADER_TOKEN_ENCRYPTED) {
    throw new EncryptedOfficeDocumentError(`${LABEL}: the presentation is encrypted or password protected.`);
  }
  if (token !== HEADER_TOKEN_PLAIN) {
    throw new LegacyOfficeFormatError(`${LABEL}: the Current User stream has an unknown header token.`);
  }
  if (readHeader(current, 0, current.length).recType !== RT_CURRENT_USER_ATOM) {
    throw new LegacyOfficeFormatError(`${LABEL}: the Current User stream does not start with a CurrentUserAtom.`);
  }
  const persist = new Map<number, number>();
  const seen = new Set<number>();
  const newestEditOffset = current.u32(CURRENT_USER_EDIT_OFFSET);
  let editOffset = newestEditOffset;
  let docPersistId = -1;
  for (let generation = 0; editOffset !== 0; generation++) {
    if (generation >= PPT_MAX_EDIT_CHAIN || seen.has(editOffset)) {
      throw new LegacyOfficeFormatError(`${LABEL}: the edit history is longer than ${PPT_MAX_EDIT_CHAIN} entries or loops.`);
    }
    seen.add(editOffset);
    const edit = readHeader(document, editOffset, document.length);
    if (edit.recType !== RT_USER_EDIT_ATOM || (edit.recLen !== USER_EDIT_BASE_LENGTH && edit.recLen !== USER_EDIT_ENCRYPTED_LENGTH)) {
      throw new LegacyOfficeFormatError(`${LABEL}: the edit record at offset ${editOffset} is not a UserEditAtom.`);
    }
    if (edit.recLen === USER_EDIT_ENCRYPTED_LENGTH && document.u32(editOffset + USER_EDIT_ENCRYPT_SESSION_OFFSET) !== 0) {
      throw new EncryptedOfficeDocumentError(`${LABEL}: the presentation is encrypted or password protected.`);
    }
    if (docPersistId < 0) docPersistId = document.u32(editOffset + USER_EDIT_DOC_PERSIST_ID_OFFSET);
    readPersistDirectory(document, document.u32(editOffset + USER_EDIT_PERSIST_DIRECTORY_OFFSET), persist);
    editOffset = document.u32(editOffset + USER_EDIT_LAST_EDIT_OFFSET);
  }
  if (docPersistId < 0) {
    throw new LegacyOfficeFormatError(`${LABEL}: the presentation has no edit record.`);
  }
  return { persist, docPersistId, newestEditOffset };
}

function persistedRecord(reader: CheckedReader, chain: EditChain, persistId: number, expectedType: number, what: string): RecordHeader {
  const offset = chain.persist.get(persistId);
  if (offset === undefined) {
    throw new LegacyOfficeFormatError(`${LABEL}: the persist directory has no entry ${persistId} for the ${what}.`);
  }
  const header = readHeader(reader, offset, reader.length);
  if (header.recType !== expectedType || header.recVer !== REC_VER_CONTAINER) {
    throw new LegacyOfficeFormatError(`${LABEL}: persist entry ${persistId} is not the ${what} record.`);
  }
  return header;
}

/** Decodes the characters of one text atom and the meta positions of its block into paragraphs-ready text. */
function decodeText(atom: RecordHeader, reader: CheckedReader): string {
  const bytes = reader.slice(atom.offset + RECORD_HEADER_BYTES, atom.recLen);
  if (atom.recType === RT_TEXT_CHARS_ATOM) {
    if (bytes.length % 2 !== 0) {
      throw new LegacyOfficeFormatError(`${LABEL}: a TextCharsAtom holds an odd number of bytes.`);
    }
    return Buffer.from(bytes).toString('utf16le');
  }
  return decodeWindows1252(bytes);
}

/** The text of a ClientTextbox or SlideListWithText block: its text atom, minus field placeholder characters. */
function readTextBlock(reader: CheckedReader, atoms: RecordHeader[]): TextBlock | null {
  let text: string | null = null;
  let style: RecordHeader | null = null;
  const metaPositions: number[] = [];
  for (const atom of atoms) {
    if (atom.recType === RT_TEXT_CHARS_ATOM || atom.recType === RT_TEXT_BYTES_ATOM) {
      text = decodeText(atom, reader);
    } else if (atom.recType === RT_STYLE_TEXT_PROP_ATOM) {
      style = atom;
    } else if (META_ATOM_TYPES.has(atom.recType) && atom.recLen >= UINT32_BYTES) {
      metaPositions.push(reader.u32(atom.offset + RECORD_HEADER_BYTES));
    }
  }
  if (text === null) return null;
  const fontRuns = style ? readCharacterFontRuns(reader.slice(style.offset + RECORD_HEADER_BYTES, style.recLen), text.length) : null;
  return { text, metaPositions, fontRuns };
}

/** Face names of the document's FontCollection, indexed as the character runs refer to them. */
function readFontNames(reader: CheckedReader, document: RecordHeader, budget: RecordBudget): string[] {
  const names: string[] = [];
  for (const environment of readChildren(reader, document, budget)) {
    if (environment.recType !== RT_ENVIRONMENT || environment.recVer !== REC_VER_CONTAINER) continue;
    for (const collection of readChildren(reader, environment, budget)) {
      if (collection.recType !== RT_FONT_COLLECTION || collection.recVer !== REC_VER_CONTAINER) continue;
      for (const entity of readChildren(reader, collection, budget)) {
        if (entity.recType !== RT_FONT_ENTITY_ATOM || entity.recLen < FONT_FACE_NAME_BYTES) continue;
        const name = Buffer.from(reader.slice(entity.offset + RECORD_HEADER_BYTES, FONT_FACE_NAME_BYTES)).toString('utf16le');
        names.push(name.split('\u0000')[0]);
      }
    }
  }
  return names;
}

/** The fonts of a presentation and the symbol characters shown as U+FFFD, in the order they were met. */
interface TextContext {
  readonly fontNames: readonly string[];
  /** Whether the output can draw a character; a mapped symbol character it cannot draw becomes U+FFFD. Absent: every character can be drawn. */
  readonly canDraw?: (character: string) => boolean;
  readonly replaced: Map<string, string>;
  replacedTotal: number;
}

/** Records one warning line per font and code, listing at most PPT_MAX_REPORTED_REPLACEMENTS and counting the rest. */
function recordReplacement(context: TextContext, font: string | undefined, code: number, warning: string): void {
  const key = `${font ?? ''}|${code}`;
  if (context.replaced.has(key)) return;
  context.replacedTotal++;
  if (context.replaced.size >= PPT_MAX_REPORTED_REPLACEMENTS) return;
  context.replaced.set(key, warning);
}

/**
 * The character a private-use code depicts in the font of its run: U+FFFD when the font has no table or no counterpart for
 * the code, and when the output cannot draw the counterpart (a PDF with no installed font that covers it).
 */
function symbolCharacter(context: TextContext, font: string | undefined, code: number): string {
  const mapped = font === undefined ? undefined : mapSymbolFontCharacter(font, code);
  if (mapped === undefined) {
    recordReplacement(context, font, code, symbolReplacementWarning(font, code));
    return REPLACEMENT_CHARACTER;
  }
  if (context.canDraw !== undefined && !context.canDraw(mapped)) {
    recordReplacement(context, font, code, undrawableSymbolWarning(font, code, mapped));
    return REPLACEMENT_CHARACTER;
  }
  return mapped;
}

/** The symbol font of the character at `index`: the run's symbol typeface, else its typeface, else none. */
function symbolFontAt(block: TextBlock, index: number, fontNames: readonly string[]): string | undefined {
  const run = block.fontRuns?.find((candidate) => index >= candidate.start && index < candidate.end);
  const ref = run?.symbolFontRef ?? run?.fontRef;
  return ref === undefined ? undefined : fontNames[ref];
}

/** Splits a text block into paragraphs: field placeholders drop out, paragraph and line breaks split. */
function paragraphsOf(block: TextBlock, context: TextContext): string[] {
  const skip = new Set(block.metaPositions);
  const paragraphs: string[] = [];
  let line = '';
  for (let i = 0; i < block.text.length; i++) {
    const ch = block.text[i];
    const code = block.text.charCodeAt(i);
    if (skip.has(i) && ch === FIELD_PLACEHOLDER) continue;
    if (code === CH_PARAGRAPH_END || code === CH_LINE_BREAK) {
      paragraphs.push(line);
      line = '';
    } else if (isSymbolFontPrivateUse(code)) {
      line += symbolCharacter(context, symbolFontAt(block, i, context.fontNames), code);
    } else if (code === CH_TAB || code >= FIRST_PRINTABLE) {
      line += ch;
    }
  }
  paragraphs.push(line);
  return paragraphs.filter((p) => p.trim().length > 0);
}

interface SlideEntry {
  persistId: number;
  /**
   * One entry per TextHeaderAtom the SlideListWithText holds for this slide, in order. A block without a text atom
   * (a footer placeholder that only carries a field) stays as null, because an OutlineTextRefAtom numbers every block.
   */
  blocks: Array<TextBlock | null>;
}

/** Reads the slide order and the outline text blocks from the document's slide SlideListWithText. */
function readSlideEntries(reader: CheckedReader, chain: EditChain, budget: RecordBudget): SlideEntry[] {
  const document = persistedRecord(reader, chain, chain.docPersistId, RT_DOCUMENT, 'document');
  const lists = readChildren(reader, document, budget).filter(
    (child) => child.recType === RT_SLIDE_LIST_WITH_TEXT && child.recInstance === SLWT_INSTANCE_SLIDES && child.recVer === REC_VER_CONTAINER
  );
  if (lists.length === 0) {
    throw new LegacyOfficeFormatError(`${LABEL}: the document has no slide list.`);
  }
  const entries: SlideEntry[] = [];
  for (const list of lists) {
    const children = readChildren(reader, list, budget);
    let index = 0;
    while (index < children.length) {
      const child = children[index];
      index++;
      if (child.recType !== RT_SLIDE_PERSIST_ATOM) continue;
      if (entries.length >= PPT_MAX_SLIDES) {
        throw new LegacyOfficeFormatError(`${LABEL}: the presentation lists more than ${PPT_MAX_SLIDES} slides.`);
      }
      const blocks: Array<TextBlock | null> = [];
      let atoms: RecordHeader[] | null = null;
      const flush = (): void => {
        if (atoms) blocks.push(readTextBlock(reader, atoms));
        atoms = null;
      };
      while (index < children.length && children[index].recType !== RT_SLIDE_PERSIST_ATOM) {
        if (children[index].recType === RT_TEXT_HEADER_ATOM) {
          flush();
          atoms = [];
        }
        atoms?.push(children[index]);
        index++;
      }
      flush();
      entries.push({ persistId: reader.u32(child.offset + SLIDE_PERSIST_REF_OFFSET), blocks });
    }
  }
  return entries;
}

/** Text of one slide: its ClientTextbox shapes in drawing order, outline references resolved. */
function readSlideTexts(
  reader: CheckedReader,
  slide: RecordHeader,
  entry: SlideEntry,
  context: TextContext,
  budget: RecordBudget
): { texts: string[]; objectIds: number[] } {
  const texts: string[] = [];
  const objectIds: number[] = [];
  const referenced = new Set<number>();
  const visit = (container: RecordHeader, depth: number): void => {
    if (depth > PPT_MAX_RECORD_DEPTH) {
      throw new LegacyOfficeFormatError(`${LABEL}: records are nested deeper than ${PPT_MAX_RECORD_DEPTH} levels.`);
    }
    for (const child of readChildren(reader, container, budget)) {
      if (child.recType === RT_EX_OBJ_REF_ATOM && child.recLen >= UINT32_BYTES) {
        objectIds.push(reader.u32(child.offset + RECORD_HEADER_BYTES));
        continue;
      }
      if (child.recVer !== REC_VER_CONTAINER) continue;
      if (child.recType === RT_CLIENT_TEXTBOX) {
        const atoms = readChildren(reader, child, budget);
        const inline = readTextBlock(reader, atoms);
        if (inline) {
          texts.push(...paragraphsOf(inline, context));
          continue;
        }
        const reference = atoms.find((atom) => atom.recType === RT_OUTLINE_TEXT_REF_ATOM);
        if (reference) {
          const index = reader.u32(reference.offset + OUTLINE_REF_INDEX_OFFSET);
          if (index >= entry.blocks.length) {
            throw new LegacyOfficeFormatError(`${LABEL}: a shape refers to outline text ${index}, but the slide has ${entry.blocks.length}.`);
          }
          referenced.add(index);
          const outline = entry.blocks[index];
          if (outline) texts.push(...paragraphsOf(outline, context));
        }
      } else {
        visit(child, depth + 1);
      }
    }
  };
  visit(slide, 0);
  // Outline text that no shape refers to still belongs to the slide.
  entry.blocks.forEach((block, index) => {
    if (block && !referenced.has(index)) texts.push(...paragraphsOf(block, context));
  });
  return { texts, objectIds };
}

/** The persist id of the storage of each embedded object, by the id the slides use for it (the ExObjList of the document). */
function readEmbeddedObjectPersistIds(reader: CheckedReader, document: RecordHeader, budget: RecordBudget): Map<number, number> {
  const persistIds = new Map<number, number>();
  for (const list of readChildren(reader, document, budget)) {
    if (list.recType !== RT_EX_OBJ_LIST || list.recVer !== REC_VER_CONTAINER) continue;
    for (const embed of readChildren(reader, list, budget)) {
      if (embed.recType !== RT_EX_EMBED || embed.recVer !== REC_VER_CONTAINER) continue;
      const atom = readChildren(reader, embed, budget).find((child) => child.recType === RT_EX_OLE_OBJ_ATOM);
      if (atom && atom.recLen >= EX_OLE_OBJ_ATOM_MIN_BYTES) {
        persistIds.set(reader.u32(atom.offset + RECORD_HEADER_BYTES + EX_OLE_OBJ_ID_OFFSET), reader.u32(atom.offset + RECORD_HEADER_BYTES + EX_OLE_OBJ_PERSIST_OFFSET));
      }
    }
  }
  return persistIds;
}

/** The compound file of an embedded object, or null (with a warning) when its storage is missing or cannot be inflated. */
function readEmbeddedObject(reader: CheckedReader, chain: EditChain, persistId: number, slideNumber: number, warnings: string[]): Buffer | null {
  const offset = chain.persist.get(persistId);
  try {
    if (offset === undefined) throw new LegacyOfficeFormatError(`${LABEL}: the persist directory has no entry ${persistId} for an embedded object.`);
    const header = readHeader(reader, offset, reader.length);
    if (header.recType !== RT_EX_OLE_OBJ_STG) throw new LegacyOfficeFormatError(`${LABEL}: persist entry ${persistId} is not an embedded object.`);
    const body = Buffer.from(reader.slice(header.offset + RECORD_HEADER_BYTES, header.recLen));
    if (header.recInstance !== EX_OLE_OBJ_STG_COMPRESSED) return body;
    return inflateSync(body.subarray(EX_OLE_OBJ_STG_SIZE_BYTES), { maxOutputLength: PPT_MAX_EMBEDDED_OBJECT_BYTES });
  } catch (error) {
    warnings.push(`Slide ${slideNumber}: an embedded object could not be read (${error instanceof Error ? error.message : 'unreadable data'}).`);
    return null;
  }
}

/**
 * Reads the slides of a PowerPoint 97-2003 presentation with their text in slide order. Malformed or empty
 * presentations throw a LegacyOfficeFormatError, encrypted ones an EncryptedOfficeDocumentError. A symbol-font character
 * with no Unicode counterpart becomes U+FFFD, and so does one whose counterpart `canDraw` (the output's glyph coverage,
 * when it has a limit) rejects; one line per font and code is appended to `warnings`.
 */
export function readPptSlides(buffer: Buffer, warnings: string[] = [], canDraw?: (character: string) => boolean): PptSlide[] {
  const streams = readCfbStreams(buffer, LABEL);
  const documentStream = new CheckedReader(requireCfbStream(streams, DOCUMENT_STREAM, LABEL), LABEL);
  const currentUser = new CheckedReader(requireCfbStream(streams, CURRENT_USER_STREAM, LABEL), LABEL);
  const chain = readEditChain(currentUser, documentStream);
  const budget = new RecordBudget();
  const entries = readSlideEntries(documentStream, chain, budget);
  const fontNames = readFontNames(documentStream, persistedRecord(documentStream, chain, chain.docPersistId, RT_DOCUMENT, 'document'), budget);
  const context: TextContext = { fontNames, canDraw, replaced: new Map(), replacedTotal: 0 };
  const documentRecord = persistedRecord(documentStream, chain, chain.docPersistId, RT_DOCUMENT, 'document');
  const objectPersistIds = readEmbeddedObjectPersistIds(documentStream, documentRecord, budget);
  const slides: PptSlide[] = entries.map((entry, i) => {
    const { texts, objectIds } = readSlideTexts(documentStream, persistedRecord(documentStream, chain, entry.persistId, RT_SLIDE, 'slide'), entry, context, budget);
    const embedded = objectIds.flatMap((objectId) => {
      const persistId = objectPersistIds.get(objectId);
      const object = persistId === undefined ? null : readEmbeddedObject(documentStream, chain, persistId, i + 1, warnings);
      return object === null ? [] : [object];
    });
    return { number: i + 1, texts, embedded };
  });
  if (slides.length === 0 || slides.every((slide) => slide.texts.length === 0)) {
    throw new LegacyOfficeFormatError(`${LABEL}: the presentation holds no slide text.`);
  }
  warnings.push(...context.replaced.values());
  const unlisted = context.replacedTotal - context.replaced.size;
  if (unlisted > 0) warnings.push(`Replaced ${unlisted} more private-use characters with U+FFFD.`);
  return slides;
}

/**
 * The file with the persistIdSeed of its newest UserEditAtom raised to the largest persist id of the persist directory,
 * or undefined when the seed already covers the directory or the file cannot be walked. [MS-PPT] 2.3.3 requires the seed
 * to be at least the largest persist id. LibreOffice sizes its persist table from the seed
 * (filter/source/msfilter/svdfppt.cxx, SdrPowerPointImport constructor: `m_nPersistPtrCnt = nMaxPersistWritten + 1`) and
 * refuses the file when a directory entry lies past it ("Not all entries of Persist-Directory read!"), while Apache POI
 * HSLF reads the directory and ignores the seed. Only the bytes of the seed change, in a copy of the input; each of its four
 * bytes is found through the sector chain of the stream the directory tree reaches, as the seed may span two sectors. Throws the
 * encrypted-document error when the presentation is encrypted: the Current User stream carries the encrypted header token
 * ([MS-PPT] 2.3.2) or the newest UserEditAtom names an encryption session ([MS-PPT] 2.3.3).
 */
export function repairPptPersistIdSeed(buffer: Buffer): Buffer | undefined {
  try {
    const container = readCfbContainer(buffer, LABEL);
    const documentBytes = requireCfbStream(container.paths, DOCUMENT_STREAM, LABEL);
    const document = new CheckedReader(documentBytes, LABEL);
    const chain = readEditChain(new CheckedReader(requireCfbStream(container.paths, CURRENT_USER_STREAM, LABEL), LABEL), document);
    const seedOffset = chain.newestEditOffset + USER_EDIT_PERSIST_ID_SEED_OFFSET;
    let largestPersistId = 0;
    for (const id of chain.persist.keys()) largestPersistId = Math.max(largestPersistId, id);
    if (document.u32(seedOffset) >= largestPersistId) return undefined;
    const positions: number[] = [];
    for (let byte = 0; byte < UINT32_BYTES; byte++) {
      const position = container.streamByteOffset(DOCUMENT_STREAM, seedOffset + byte);
      if (position === undefined || buffer[position] !== documentBytes[seedOffset + byte]) return undefined;
      positions.push(position);
    }
    const seed = Buffer.alloc(UINT32_BYTES);
    seed.writeUInt32LE(largestPersistId);
    const repaired = Buffer.from(buffer);
    positions.forEach((position, byte) => {
      repaired[position] = seed[byte];
    });
    return repaired;
  } catch (err) {
    if (err instanceof ConversionFailedError && !(err instanceof EncryptedOfficeDocumentError)) return undefined;
    throw err;
  }
}
