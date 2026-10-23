import { type CraftObject, buildPdf, flate, HELVETICA_FONT } from './pdf-craft';

/**
 * One-page PDFs whose text sits in annotation appearance streams (ISO 32000-1 sections 12.5.2 and 12.5.5), written by
 * hand so that Poppler (`pdftotext`) reads the same bytes as the converter. Annotation flag bits follow table 165.
 */

export const FLAG_INVISIBLE = 1;
export const FLAG_HIDDEN = 2;
export const FLAG_PRINT = 4;
export const FLAG_NO_VIEW = 32;

const PAGE_OBJECT = 3;
const FIRST_ANNOTATION_OBJECT = 10;
const FONT_OBJECT = 5;
const WIDTH = 120;
const HEIGHT = 20;

export interface AnnotationSpec {
  subtype: 'Widget' | 'FreeText' | 'Stamp' | 'Highlight' | 'Link';
  /** Text the appearance stream draws; omit for an annotation without an appearance. */
  text?: string;
  flags?: number;
  /** Lower-left corner of /Rect on the page. */
  x?: number;
  y?: number;
  /** Extra entries of the annotation dictionary. */
  extra?: string;
}

/** The appearance stream of an annotation: a form XObject whose box is the annotation's size, drawing `text` in Helvetica. */
export function appearanceStream(text: string, extra = ''): Omit<CraftObject, 'id'> {
  const content = `BT /F1 12 Tf 2 5 Td (${text}) Tj ET`;
  return {
    dict: `/Type /XObject /Subtype /Form /BBox [0 0 ${WIDTH} ${HEIGHT}] /Resources << /Font << /F1 ${FONT_OBJECT} 0 R >> >> ${extra}`,
    stream: Buffer.from(content, 'latin1'),
  };
}

function annotationDict(spec: AnnotationSpec, appearanceObject: number | null): string {
  const x = spec.x ?? 72;
  const y = spec.y ?? 600;
  const field = spec.subtype === 'Widget' ? '/FT /Btn /Ff 65536 /T (Field)' : '';
  const flags = spec.flags === undefined ? '' : `/F ${spec.flags}`;
  const appearance = appearanceObject === null ? '' : `/AP << /N ${appearanceObject} 0 R >>`;
  return `/Type /Annot /Subtype /${spec.subtype} /Rect [${x} ${y} ${x + WIDTH} ${y + HEIGHT}] ${field} ${flags} ${appearance} ${spec.extra ?? ''}`;
}

/** Objects of the annotations: for each, the annotation dictionary and, when it has text, its appearance stream. */
export function annotationObjects(specs: readonly AnnotationSpec[]): { objects: CraftObject[]; references: string[] } {
  const objects: CraftObject[] = [];
  const references: string[] = [];
  let next = FIRST_ANNOTATION_OBJECT;
  for (const spec of specs) {
    const annotation = next++;
    const appearance = spec.text === undefined ? null : next++;
    objects.push({ id: annotation, dict: annotationDict(spec, appearance) });
    if (appearance !== null && spec.text !== undefined) objects.push({ id: appearance, ...appearanceStream(spec.text) });
    references.push(`${annotation} 0 R`);
  }
  return { objects, references };
}

/** A page that draws `pageText` itself (when given) and carries the annotations; `catalogExtra` adds entries to the catalog. */
export function annotatedPdf(specs: readonly AnnotationSpec[], pageText?: string, catalogExtra = ''): Buffer {
  const { objects, references } = annotationObjects(specs);
  const content = pageText === undefined ? '' : `BT /F1 12 Tf 72 700 Td (${pageText}) Tj ET`;
  return buildPdf(
    [
      { id: 1, dict: `/Type /Catalog /Pages 2 0 R ${catalogExtra}` },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      {
        id: PAGE_OBJECT,
        dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 ${FONT_OBJECT} 0 R >> >> /Annots [${references.join(' ')}]`,
      },
      { id: 4, dict: '/Filter /FlateDecode', stream: flate(content) },
      { id: FONT_OBJECT, raw: HELVETICA_FONT },
      ...objects,
    ],
    1
  ).buffer;
}

/** A page with one text field that has a value and no appearance stream; `needAppearances` sets the form's flag that asks viewers to draw it. */
export function textFieldPdf(value: string, needAppearances: boolean): Buffer {
  const form = `/AcroForm << /Fields [10 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv ${FONT_OBJECT} 0 R >> >> ${needAppearances ? '/NeedAppearances true' : ''} >>`;
  return buildPdf(
    [
      { id: 1, dict: `/Type /Catalog /Pages 2 0 R ${form}` },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: PAGE_OBJECT, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 ${FONT_OBJECT} 0 R >> >> /Annots [10 0 R]` },
      { id: 4, dict: '/Filter /FlateDecode', stream: flate('') },
      { id: FONT_OBJECT, raw: HELVETICA_FONT },
      { id: 10, dict: `/Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (${value}) /DA (/Helv 12 Tf 0 g) /F 4 /Rect [72 600 272 620]` },
    ],
    1
  ).buffer;
}

/** A page with a check box whose appearance dictionary names one stream per state and whose /AS selects `selected`. */
export function checkBoxPdf(selected: 'Yes' | 'Off'): Buffer {
  return buildPdf(
    [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: PAGE_OBJECT, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 ${FONT_OBJECT} 0 R >> >> /Annots [10 0 R]` },
      { id: 4, dict: '/Filter /FlateDecode', stream: flate('') },
      { id: FONT_OBJECT, raw: HELVETICA_FONT },
      { id: 10, dict: `/Type /Annot /Subtype /Widget /FT /Btn /T (box) /F 4 /AS /${selected} /Rect [72 600 192 620] /AP << /N << /Yes 11 0 R /Off 12 0 R >> >>` },
      { id: 11, ...appearanceStream('CheckedState') },
      { id: 12, ...appearanceStream('UncheckedState') },
    ],
    1
  ).buffer;
}

/** A page with two widgets: the first appearance stream is not valid Flate data, the second draws `text`. */
export function damagedAppearancePdf(text: string): Buffer {
  return buildPdf(
    [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: PAGE_OBJECT, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 ${FONT_OBJECT} 0 R >> >> /Annots [10 0 R 11 0 R]` },
      { id: 4, dict: '/Filter /FlateDecode', stream: flate('') },
      { id: FONT_OBJECT, raw: HELVETICA_FONT },
      { id: 10, dict: `/Type /Annot /Subtype /Widget /FT /Btn /T (a) /F 4 /Rect [72 600 192 620] /AP << /N 12 0 R >>` },
      { id: 11, dict: `/Type /Annot /Subtype /Widget /FT /Btn /T (b) /F 4 /Rect [72 560 192 580] /AP << /N 13 0 R >>` },
      { id: 12, dict: `/Type /XObject /Subtype /Form /BBox [0 0 ${WIDTH} ${HEIGHT}] /Filter /FlateDecode`, stream: Buffer.from('not flate data at all', 'latin1') },
      { id: 13, ...appearanceStream(text) },
    ],
    1
  ).buffer;
}
