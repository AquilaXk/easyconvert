import { buildCompoundFile } from './cfb-craft';

/**
 * Hand-written PowerPoint 97-2003 binary presentations, authored from [MS-PPT]: record headers, a
 * DocumentContainer with SlideListWithText, slide containers whose drawings hold ClientTextbox shapes,
 * a master and a notes page that carry text of their own, persist directories, UserEditAtoms and the
 * Current User stream. It shares no code with the reader under test.
 */

const REC_VER_CONTAINER = 0xf;
const RT_DOCUMENT = 0x03e8;
const RT_DOCUMENT_ATOM = 0x03e9;
const RT_ENVIRONMENT = 0x03f2;
const RT_FONT_COLLECTION = 0x07d5;
const RT_FONT_ENTITY_ATOM = 0x0fb7;
const RT_STYLE_TEXT_PROP_ATOM = 0x0fa1;
const RT_SLIDE = 0x03ee;
const RT_SLIDE_ATOM = 0x03ef;
const RT_NOTES = 0x03f0;
const RT_SLIDE_PERSIST_ATOM = 0x03f3;
const RT_MAIN_MASTER = 0x03f8;
const RT_PP_DRAWING = 0x040c;
const RT_SLIDE_LIST_WITH_TEXT = 0x0ff0;
const RT_USER_EDIT_ATOM = 0x0ff5;
const RT_CURRENT_USER_ATOM = 0x0ff6;
const RT_TEXT_HEADER_ATOM = 0x0f9f;
const RT_TEXT_CHARS_ATOM = 0x0fa0;
const RT_TEXT_BYTES_ATOM = 0x0fa8;
const RT_OUTLINE_TEXT_REF_ATOM = 0x0f9e;
const RT_SLIDE_NUMBER_META_ATOM = 0x0fd8;
const RT_PERSIST_DIRECTORY_ATOM = 0x1772;
const ESCHER_DG_CONTAINER = 0xf002;
const ESCHER_SPGR_CONTAINER = 0xf003;
const ESCHER_SP_CONTAINER = 0xf004;
const ESCHER_CLIENT_TEXTBOX = 0xf00d;
const ESCHER_OPT = 0xf00b;
const SLWT_SLIDES = 0;
const SLWT_MASTERS = 1;
const SLWT_NOTES = 2;
const TEXT_TYPE_BODY = 1;
const TEXT_TYPE_OTHER = 4;
const FIRST_SLIDE_PERSIST_ID = 3;
const DOCUMENT_PERSIST_ID = 1;
const MASTER_PERSIST_ID = 2;
const HEADER_TOKEN_PLAIN = 0xe391c05f;
const HEADER_TOKEN_ENCRYPTED = 0xf3d1c4df;
const PERSIST_COUNT_SHIFT = 20;
const FIRST_SLIDE_ID = 256;

/** Windows-1252 bytes of the characters above U+007F the tests store in TextBytesAtoms, from the code page chart. */
const CP1252_EXTRA: Readonly<Record<string, number>> = { '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97, '€': 0x80, '…': 0x85 };

/** Characters of one stretch of text and the fonts its character formatting names. */
export interface PptFontRun {
  count: number;
  /** Face used for ordinary characters (TextCFException typeface). */
  font?: string;
  /** Face used for symbol-range characters (TextCFException symbolTypeface). */
  symbolFont?: string;
}

export type PptShape =
  | { chars: string; fieldAt?: number; fontRuns?: PptFontRun[] }
  | { bytes: string }
  | { outlineIndex: number };

export interface PptSlideSpec {
  shapes: PptShape[];
  /**
   * Text blocks of the slide in the SlideListWithText; shapes reach them through `outlineIndex`. A `null` block is
   * a TextHeaderAtom that carries only a slide number field and no text atom, as real files store a footer placeholder.
   */
  outline?: (string | null)[];
}

export interface PptBuildOptions {
  slides: PptSlideSpec[];
  masterText?: string;
  notesText?: string;
  encrypted?: boolean;
  /** A later edit that replaces whole slides; the earlier slide records stay in the stream, unreferenced. */
  revisedSlides?: Record<number, PptSlideSpec>;
  /** Stores the slide records in reverse order, so slide order cannot come from the stream order. */
  reverseSlideStorage?: boolean;
  /** Makes the newest UserEditAtom name itself as its predecessor. */
  loopingEditChain?: boolean;
  /** Wraps every slide drawing in this many extra containers. */
  extraNesting?: number;
  /** Cuts this many bytes off the end of the PowerPoint Document stream. */
  truncateDocumentBy?: number;
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}

function record(version: number, instance: number, type: number, body: Buffer): Buffer {
  return Buffer.concat([u16(version | (instance << 4)), u16(type), u32(body.length), body]);
}

function container(instance: number, type: number, children: Buffer[]): Buffer {
  return record(REC_VER_CONTAINER, instance, type, Buffer.concat(children));
}

function encodeBytes(text: string): Buffer {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const mapped = CP1252_EXTRA[text[i]];
    if (mapped !== undefined) out[i] = mapped;
    else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out[i] = code;
    else throw new Error(`U+${code.toString(16)} cannot be stored in a TextBytesAtom`);
  }
  return out;
}

function textHeader(type: number): Buffer {
  return record(0, 0, RT_TEXT_HEADER_ATOM, u32(type));
}

function fontIndex(fonts: string[], name: string): number {
  const found = fonts.indexOf(name);
  if (found >= 0) return found;
  fonts.push(name);
  return fonts.length - 1;
}

/** One paragraph run over the whole text, then one character run per entry; both cover the text plus its closing paragraph mark. */
function styleTextPropAtom(length: number, runs: PptFontRun[], fonts: string[]): Buffer {
  const covered = runs.reduce((sum, run) => sum + run.count, 0);
  if (covered !== length) throw new Error(`font runs cover ${covered} characters of ${length}`);
  const parts: Buffer[] = [u32(length + 1), u16(0), u32(0)];
  runs.forEach((run, i) => {
    const count = run.count + (i === runs.length - 1 ? 1 : 0);
    const masks = (run.font === undefined ? 0 : 0x10000) | (run.symbolFont === undefined ? 0 : 0x800000);
    parts.push(u32(count), u32(masks));
    if (run.font !== undefined) parts.push(u16(fontIndex(fonts, run.font)));
    if (run.symbolFont !== undefined) parts.push(u16(fontIndex(fonts, run.symbolFont)));
  });
  return record(0, 0, RT_STYLE_TEXT_PROP_ATOM, Buffer.concat(parts));
}

function fontCollection(fonts: string[]): Buffer {
  const entities = fonts.map((name) => {
    const face = Buffer.alloc(64);
    face.write(name, 'utf16le');
    return record(0, 0, RT_FONT_ENTITY_ATOM, Buffer.concat([face, Buffer.alloc(4)]));
  });
  return container(0, RT_ENVIRONMENT, [container(0, RT_FONT_COLLECTION, entities)]);
}

function charsAtom(text: string): Buffer {
  return record(0, 0, RT_TEXT_CHARS_ATOM, Buffer.from(text, 'utf16le'));
}

function shapeContainer(shape: PptShape, fonts: string[]): Buffer {
  let textbox: Buffer[];
  if ('outlineIndex' in shape) {
    textbox = [textHeader(TEXT_TYPE_BODY), record(0, 0, RT_OUTLINE_TEXT_REF_ATOM, u32(shape.outlineIndex))];
  } else if ('bytes' in shape) {
    textbox = [textHeader(TEXT_TYPE_OTHER), record(0, 0, RT_TEXT_BYTES_ATOM, encodeBytes(shape.bytes))];
  } else {
    textbox = [textHeader(TEXT_TYPE_OTHER), charsAtom(shape.chars)];
    if (shape.fontRuns) textbox.push(styleTextPropAtom(shape.chars.length, shape.fontRuns, fonts));
    if (shape.fieldAt !== undefined) textbox.push(record(0, 0, RT_SLIDE_NUMBER_META_ATOM, u32(shape.fieldAt)));
  }
  // A shape property table sits before the text box, as in real files; its content is not interpreted.
  return container(0, ESCHER_SP_CONTAINER, [record(3, 0, ESCHER_OPT, Buffer.alloc(6)), container(0, ESCHER_CLIENT_TEXTBOX, textbox)]);
}

function drawing(shapes: Buffer[], extraNesting = 0): Buffer {
  let group = container(0, ESCHER_SPGR_CONTAINER, shapes);
  for (let i = 0; i < extraNesting; i++) group = container(0, ESCHER_SPGR_CONTAINER, [group]);
  return container(0, RT_PP_DRAWING, [container(0, ESCHER_DG_CONTAINER, [group])]);
}

function slideContainer(spec: PptSlideSpec, fonts: string[], extraNesting = 0): Buffer {
  return container(0, RT_SLIDE, [record(2, 0, RT_SLIDE_ATOM, Buffer.alloc(24)), drawing(spec.shapes.map((shape) => shapeContainer(shape, fonts)), extraNesting)]);
}

function slideListEntries(slides: PptSlideSpec[]): Buffer[] {
  const out: Buffer[] = [];
  slides.forEach((spec, i) => {
    const blocks = spec.outline ?? [];
    out.push(
      record(0, 0, RT_SLIDE_PERSIST_ATOM, Buffer.concat([u32(FIRST_SLIDE_PERSIST_ID + i), u32(0), u32(blocks.length), u32(FIRST_SLIDE_ID + i), u32(0)]))
    );
    for (const block of blocks) {
      if (block === null) out.push(textHeader(TEXT_TYPE_OTHER), record(0, 0, RT_SLIDE_NUMBER_META_ATOM, u32(0)));
      else out.push(textHeader(TEXT_TYPE_BODY), charsAtom(block));
    }
  });
  return out;
}

export function buildPptBinary(options: PptBuildOptions): Buffer {
  const parts: Buffer[] = [];
  let length = 0;
  const append = (buffer: Buffer): number => {
    const at = length;
    parts.push(buffer);
    length += buffer.length;
    return at;
  };

  const slideCount = options.slides.length;
  const masterId = MASTER_PERSIST_ID;
  const notesId = FIRST_SLIDE_PERSIST_ID + slideCount;
  const fonts: string[] = [];
  const slideBuffers = options.slides.map((spec) => slideContainer(spec, fonts, options.extraNesting));
  const revisedBuffers = Object.entries(options.revisedSlides ?? {}).map(([index, spec]): [number, Buffer] => [Number(index), slideContainer(spec, fonts)]);
  const documentChildren = [
    record(1, 0, RT_DOCUMENT_ATOM, Buffer.alloc(40)),
    fontCollection(fonts),
    container(SLWT_MASTERS, RT_SLIDE_LIST_WITH_TEXT, [
      record(0, 0, RT_SLIDE_PERSIST_ATOM, Buffer.concat([u32(masterId), u32(0), u32(0), u32(0x80000000), u32(0)])),
    ]),
    container(SLWT_SLIDES, RT_SLIDE_LIST_WITH_TEXT, slideListEntries(options.slides)),
    container(SLWT_NOTES, RT_SLIDE_LIST_WITH_TEXT, [
      record(0, 0, RT_SLIDE_PERSIST_ATOM, Buffer.concat([u32(notesId), u32(0), u32(0), u32(FIRST_SLIDE_ID), u32(0)])),
    ]),
  ];
  const offsets = new Map<number, number>();
  offsets.set(DOCUMENT_PERSIST_ID, append(container(0, RT_DOCUMENT, documentChildren)));
  offsets.set(masterId, append(container(0, RT_MAIN_MASTER, [drawing([shapeContainer({ chars: options.masterText ?? 'Click to edit the master title style' }, fonts)])])));
  const storageOrder = options.slides.map((_, i) => i);
  if (options.reverseSlideStorage) storageOrder.reverse();
  for (const i of storageOrder) {
    offsets.set(FIRST_SLIDE_PERSIST_ID + i, append(slideBuffers[i]));
  }
  offsets.set(
    notesId,
    append(container(0, RT_NOTES, [drawing([shapeContainer({ chars: options.notesText ?? 'Speaker notes that are not slide text' }, fonts)])]))
  );

  const persistDirectory = (entries: Map<number, number>): Buffer => {
    const ids = [...entries.keys()].sort((a, b) => a - b);
    const runs: Buffer[] = [];
    let start = 0;
    while (start < ids.length) {
      let end = start;
      while (end + 1 < ids.length && ids[end + 1] === ids[end] + 1) end++;
      const count = end - start + 1;
      runs.push(u32((count << PERSIST_COUNT_SHIFT) | ids[start]), ...ids.slice(start, end + 1).map((id) => u32(entries.get(id) as number)));
      start = end + 1;
    }
    return record(0, 0, RT_PERSIST_DIRECTORY_ATOM, Buffer.concat(runs));
  };
  const userEdit = (directoryAt: number, lastEditAt: number): Buffer =>
    record(
      0,
      0,
      RT_USER_EDIT_ATOM,
      Buffer.concat([u32(FIRST_SLIDE_ID), u16(0), Buffer.from([0, 3]), u32(lastEditAt), u32(directoryAt), u32(DOCUMENT_PERSIST_ID), u32(notesId + 1), u16(1), u16(0)])
    );

  let directoryAt = append(persistDirectory(offsets));
  let editAt = append(userEdit(directoryAt, options.loopingEditChain ? length : 0));

  if (options.revisedSlides) {
    const revised = new Map<number, number>();
    for (const [index, buffer] of revisedBuffers) revised.set(FIRST_SLIDE_PERSIST_ID + index, append(buffer));
    directoryAt = append(persistDirectory(revised));
    editAt = append(userEdit(directoryAt, editAt));
  }

  const currentUser = record(
    0,
    0,
    RT_CURRENT_USER_ATOM,
    Buffer.concat([u32(0x14), u32(options.encrypted ? HEADER_TOKEN_ENCRYPTED : HEADER_TOKEN_PLAIN), u32(editAt), u16(0), u16(0x03f4), Buffer.from([3, 0]), u16(0)])
  );
  return buildCompoundFile([
    { name: 'Current User', data: currentUser },
    { name: 'PowerPoint Document', data: Buffer.concat(parts).subarray(0, length - (options.truncateDocumentBy ?? 0)) },
  ]);
}
