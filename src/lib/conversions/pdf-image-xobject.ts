import { PDFName, type PDFArray, type PDFDocument, type PDFRef } from 'pdf-lib';

/**
 * A PDF image XObject planned from already-compressed pixels, and the code that writes it into a document. This
 * module only needs pdf-lib, so the browser OCR bundle can carry it; the Node-side PNG reader that makes the plans
 * is in pdf-image-passthrough.ts.
 */

/** `/K` of a pure two-dimensional (T.6) CCITT stream (ISO 32000-1 Table 11). */
const CCITT_K_GROUP4 = -1;
/** The predictor value for "PNG, optimum": every row carries its own filter byte (ISO 32000-1 7.4.4.4). */
const PDF_PREDICTOR_PNG_OPTIMUM = 15;
const PALETTE_ENTRY_BYTES = 3;

export type PdfImageEncoding = 'flate-predictor' | 'ccitt-g4';

export type ColorSpace =
  | { readonly kind: 'gray' }
  | { readonly kind: 'rgb' }
  | { readonly kind: 'indexed'; readonly palette: Uint8Array };

export interface IccProfile {
  /** The profile exactly as the PNG stores it: a zlib stream, which is also a valid FlateDecode stream. */
  readonly compressed: Uint8Array;
  readonly components: 1 | 3;
}

/** A PNG ready to become a PDF image XObject: its dictionary values and the stream bytes. */
export interface PdfImagePlan {
  readonly encoding: PdfImageEncoding;
  readonly width: number;
  readonly height: number;
  readonly bitsPerComponent: number;
  readonly colors: number;
  readonly colorSpace: ColorSpace;
  readonly icc?: IccProfile;
  readonly data: Uint8Array;
}


/** Adds the planned image to `doc` as an image XObject and returns its reference. */
export function embedImagePlan(doc: PDFDocument, plan: PdfImagePlan): PDFRef {
  const { context } = doc;
  let device: PDFName | PDFArray = PDFName.of(plan.colorSpace.kind === 'gray' ? 'DeviceGray' : 'DeviceRGB');
  if (plan.icc !== undefined) {
    const profile = context.stream(plan.icc.compressed, {
      N: plan.icc.components,
      Alternate: plan.icc.components === 1 ? 'DeviceGray' : 'DeviceRGB',
      Filter: 'FlateDecode',
    });
    device = context.obj([PDFName.of('ICCBased'), context.register(profile)]);
  }
  let space = device;
  if (plan.colorSpace.kind === 'indexed') {
    const lookup = context.register(context.stream(plan.colorSpace.palette));
    const entries = plan.colorSpace.palette.length / PALETTE_ENTRY_BYTES;
    space = context.obj([PDFName.of('Indexed'), device, entries - 1, lookup]);
  }
  const filter =
    plan.encoding === 'ccitt-g4'
      ? { Filter: 'CCITTFaxDecode', DecodeParms: { K: CCITT_K_GROUP4, Columns: plan.width, Rows: plan.height } }
      : {
          Filter: 'FlateDecode',
          DecodeParms: {
            Predictor: PDF_PREDICTOR_PNG_OPTIMUM,
            Colors: plan.colors,
            BitsPerComponent: plan.bitsPerComponent,
            Columns: plan.width,
          },
        };
  return context.register(
    context.stream(plan.data, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: plan.width,
      Height: plan.height,
      ColorSpace: space,
      BitsPerComponent: plan.bitsPerComponent,
      ...filter,
    })
  );
}
