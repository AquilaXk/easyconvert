import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createValidatorScripts, withValidator, type ValidatorScripts } from './helpers/pdfa-route-harness';
import { verifyPdfA } from '../src/lib/conversions/pdf-postprocess';
import { EngineUnavailableError } from '../src/lib/types';

/**
 * The detail of an engine-unavailable answer is fixed text. The validators here are executable
 * scripts that fail in a fixed way; the PDF is a real PDF/A-2b-identified file pdf-lib wrote.
 */

const NOT_EXECUTABLE_MODE = 0o644;

let validators: ValidatorScripts;
let pdfa2b: Buffer;

async function identifiedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ' +
    'xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>2</pdfaid:part>' +
    '<pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
  return Buffer.from(await doc.save());
}

beforeAll(async () => {
  validators = createValidatorScripts();
  pdfa2b = await identifiedPdf();
});

afterAll(() => {
  validators.dispose();
});

describe('validator failure detail', () => {
  it('answers with fixed text, not the path, when the validator cannot be started', async () => {
    const validator = validators.write('verapdf-not-executable', 'echo unreachable');
    fs.chmodSync(validator, NOT_EXECUTABLE_MODE);

    const error = await withValidator(validator, () => verifyPdfA(pdfa2b, 'pdfa-2b')).then(
      () => {
        throw new Error('verifyPdfA accepted a validator that cannot run');
      },
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as EngineUnavailableError).message).toBe("Engine 'verapdf' is unavailable: veraPDF could not be started");
  });
});
