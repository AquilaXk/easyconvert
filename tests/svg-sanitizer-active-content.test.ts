import { describe, expect, it } from 'vitest';
import { sanitizeSvgString } from '../src/lib/security/svg-sanitizer';

/**
 * What a viewer would fetch or submit from a picture without running a script: a style sheet named by a processing instruction, the
 * address of an HTML form, and a link to a markup document in a `data:` URI. None of them survives; the XML declaration and
 * embedded raster pictures do.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('processing instructions', () => {
  it.each([
    ['an xml-stylesheet', '<?xml-stylesheet href="https://attacker.example/x.css" type="text/css"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['an xml-stylesheet after the declaration', '<?xml version="1.0"?><?xml-stylesheet href="x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['an xml-stylesheet in the body', '<svg xmlns="http://www.w3.org/2000/svg"><?xml-stylesheet href="x.css"?><rect/></svg>'],
    ['an instruction whose target only starts with xml', '<?xmlfoo href="x"?><svg/>'],
    ['a declaration that is not at the start', '<svg><?xml version="1.0"?></svg>'],
  ])('drops %s', (_label, svg) => {
    const clean = sanitizeSvgString(svg);

    expect(clean).not.toContain('xml-stylesheet');
    expect(clean).not.toContain('xmlfoo');
    expect(clean).not.toMatch(/<svg[^>]*>.*<\?/s);
  });

  it('keeps the XML declaration at the start of the document', () => {
    const svg = '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

    expect(sanitizeSvgString(svg)).toBe(svg);
  });

  it('leaves `<?` in a comment, a CDATA section and an attribute value alone', () => {
    const svg = '<svg><!-- <?p x?> --><text title="<?p x?>"><![CDATA[<?p x?>]]></text></svg>';

    expect(sanitizeSvgString(svg)).toBe(svg);
  });

  it('removes an instruction that has no end, through the end of the input', () => {
    expect(sanitizeSvgString('<svg><rect/><?p <rect onclick="x"/>')).toBe('<svg><rect/>');
  });

  it('does not let the removal join its two sides into a tag', () => {
    const clean = sanitizeSvgString('<svg><scr<?x?>ipt>alert(1)</scr<?x?>ipt></svg>');

    expect(clean).not.toMatch(/<script/i);
  });
});

describe('forms', () => {
  it('drops a form element with its content', () => {
    expect(sanitizeSvgString('<svg><form action="https://attacker.example/"><rect/></form><circle/></svg>')).toBe('<svg><circle/></svg>');
  });

  it('drops the form attributes of any element, however they are spelled', () => {
    const clean = sanitizeSvgString('<svg><a action="https://e/x" FormAction="https://e/y" h:formaction="https://e/z" id="k"><rect/></a></svg>');

    expect(clean).not.toMatch(/action/i);
    expect(clean).toContain('id="k"');
  });

  it('drops an animation that would write a form attribute', () => {
    const clean = sanitizeSvgString('<svg><set attributeName="formaction" to="javascript:alert(1)"/><rect/></svg>');

    expect(clean).toBe('<svg><rect/></svg>');
  });
});

describe('data: links', () => {
  it.each([
    ['text/xml', 'data:text/xml,<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['application/xml', 'data:application/xml;base64,PHN2Zy8+'],
    ['application/xhtml+xml', 'data:application/xhtml+xml,<html/>'],
    ['no type', 'data:,hello'],
    ['image/bmp', 'data:image/bmp;base64,Qk0='],
    ['a type that only starts like a raster one', 'data:image/pngx;base64,AAAA'],
  ])('neutralizes %s on an image', (_label, uri) => {
    const clean = sanitizeSvgString(`<svg><image href="${uri.replace(/"/g, '&quot;')}"/></svg>`);

    expect(clean).toBe('<svg><image href="#"/></svg>');
  });

  it('neutralizes a markup document on xlink:href of an element that is not an image', () => {
    expect(sanitizeSvgString('<svg><use xlink:href="data:text/xml,x"/></svg>')).toBe('<svg><use href="#"/></svg>');
  });

  it('refuses an animation that points a link at a markup document', () => {
    expect(sanitizeSvgString('<svg><set attributeName="href" to="data:text/xml,x"/><rect/></svg>')).toBe('<svg><rect/></svg>');
  });

  it.each(['png', 'jpeg', 'gif', 'webp'])('keeps an embedded %s picture', (type) => {
    const svg = `<svg><image href="data:image/${type};base64,AAAA"/></svg>`;

    expect(sanitizeSvgString(svg)).toBe(svg);
  });

  it('keeps a raster picture whose type is written in capitals or split by white space', () => {
    expect(sanitizeSvgString(`<svg><image href="DATA:IMAGE/PNG;base64,AAAA"/></svg>`)).toContain('DATA:IMAGE/PNG');
    expect(sanitizeSvgString(`<svg><image href="${PNG}"/></svg>`)).toContain(PNG);
  });

  it('still sanitizes an embedded SVG picture instead of dropping it', () => {
    const inner = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>').toString('base64');

    const clean = sanitizeSvgString(`<svg><image href="data:image/svg+xml;base64,${inner}"/></svg>`);

    expect(clean).toContain(`data:image/svg+xml;base64,${inner}`);
  });
});
