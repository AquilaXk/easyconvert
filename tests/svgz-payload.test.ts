import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { decodeRgba } from './helpers/image-pixels';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * The signature check of `.svgz` sees only the gzip header; what the stream holds is judged where it is inflated: a
 * stream that is not an SVG document is refused with a typed error, whatever it is.
 */

const NOT_SVG = { name: 'ConversionFailedError', message: 'Invalid image: the SVGZ payload is not an SVG document' };
const PNG_HEADER = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#f00"/></svg>';

describe('the payload of an .svgz file', () => {
  it.each([
    ['a PNG', PNG_HEADER],
    ['plain text', Buffer.from('hello, this is not a drawing')],
    ['a program', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 1)])],
    ['JSON', Buffer.from('{"svg": true}')],
  ])('is refused when it is %s', async (_label, payload) => {
    for (const target of ['png', 'pdf', 'svg']) {
      await expect(dispatchConversion(zlib.gzipSync(payload), 'svgz', target, {}, 'drawing.svgz')).rejects.toMatchObject(NOT_SVG);
    }
  });

  it('converts when it is an SVG document, with a declaration and a comment before the root element', async () => {
    const withPreamble = `<?xml version="1.0"?><!-- drawn by hand --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${SVG.replace('<?xml version="1.0"?>', '')}`;
    for (const text of [SVG, withPreamble]) {
      const picture = await decodeRgba((await dispatchConversion(zlib.gzipSync(Buffer.from(text)), 'svgz', 'png', {}, 'drawing.svgz')).buffer);
      expect(Array.from(picture.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    }
  });

  it.for(['okular-checkmark.svgz', 'okular-hisc-apps-okular.svgz', 'tika-testsvg.svgz'])('is accepted for the real file %s', async (id, ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    const picture = await decodeRgba((await dispatchConversion(sample.bytes, 'svgz', 'png', {}, id)).buffer);
    expect(picture.width).toBeGreaterThan(1);
    expect(picture.height).toBeGreaterThan(1);
  });
});
