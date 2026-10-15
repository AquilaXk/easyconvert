import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { PDFDocument } from 'pdf-lib';
import { PdfWatermarkOptionsSchema } from '../src/lib/api/contracts/schemas';
import { applyPdfWatermark } from '../src/lib/conversions/pdf-postprocess';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { UnsupportedOptionError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';

/**
 * Option values that cannot be applied are refused, not replaced: a watermark colour that is not a hex or rgb()
 * colour is a 400 at the API and a typed error in the engine, and a raster density outside 72-600 dpi is a typed
 * error in the worker instead of a silent 150.
 */

async function onePagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

describe('watermark fontColor', () => {
  const validate = new Ajv({ strict: false }).compile(PdfWatermarkOptionsSchema);

  it.each(['#abc', '#A1B2C3', 'rgb(1,2,3)', 'rgb( 255 , 0 , 128 )'])('the API schema accepts %s', (fontColor) => {
    expect(validate({ type: 'text', text: 'x', fontColor })).toBe(true);
  });

  it.each(['blue-ish', '#12', '#12345', '#gggggg', 'rgb(1,2)', 'red', ''])('the API schema rejects %j', (fontColor) => {
    expect(validate({ type: 'text', text: 'x', fontColor })).toBe(false);
    expect(validate.errors?.map((error) => error.instancePath)).toEqual(['/fontColor']);
  });

  it('the engine throws a typed option error for a colour it cannot read, naming the value', async () => {
    const failure = await applyPdfWatermark(await onePagePdf(), { type: 'text', text: 'draft', fontColor: 'blue-ish' }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(UnsupportedOptionError);
    expect((failure as Error).message).toBe('The watermark fontColor "blue-ish" is not a #rgb, #rrggbb or rgb(r,g,b) colour.');
  });

  it('the engine refuses an rgb() channel above 255', async () => {
    const failure = await applyPdfWatermark(await onePagePdf(), { type: 'text', text: 'draft', fontColor: 'rgb(300,0,0)' }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(UnsupportedOptionError);
    expect((failure as Error).message).toBe('The watermark fontColor "rgb(300,0,0)" is not a #rgb, #rrggbb or rgb(r,g,b) colour.');
  });

  it('a valid colour still applies', async () => {
    const output = await applyPdfWatermark(await onePagePdf(), { type: 'text', text: 'draft', fontColor: '#ff0000' });
    expect(output.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('raster density', () => {
  oracleTest('a dpi outside 72-600 is refused with a typed option error', ['pdftoppm'], async () => {
    const failure = await dispatchConversion(await onePagePdf(), 'pdf', 'png', { dpi: 9999 }, 'x.pdf').then(
      () => undefined,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(UnsupportedOptionError);
    expect((failure as Error).message).toBe('The dpi option 9999 is outside the supported range of 72 to 600.');
  });
});
