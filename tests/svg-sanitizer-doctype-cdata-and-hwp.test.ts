import { SaxesParser } from 'saxes';
import { describe, expect, it } from 'vitest';
import { buildCfbfContainer } from '../src/lib/conversions/cfbf-writer';
import { MAX_SVG_INPUT_CHARS } from '../src/lib/conversions/svg-geometry';
import { isSvg, sanitizeSvgDocument, sanitizeSvgString } from '../src/lib/security/svg-sanitizer';
import { SvgSanitizationError } from '../src/lib/types';
import { planTextPdfRoute } from '../src/worker/text-pdf-route';
import { binData, controlUnits, objectProperties, pack, para, picture, rec, TAG } from './helpers/hwp-craft';

function parseXmlStrict(xml: string): string[] {
  const parser = new SaxesParser({ xmlns: true });
  const openedTags: string[] = [];
  parser.on('error', (err) => {
    throw err;
  });
  parser.on('opentag', (node) => {
    openedTags.push(node.name);
  });
  parser.write(xml).close();
  return openedTags;
}

function buildHwpWithEmbeddedSvg(svgBytes: Buffer): Buffer {
  const fileHeader = Buffer.alloc(256);
  fileHeader.write('HWP Document File', 0, 'latin1');
  fileHeader.writeUInt32LE(0x05000300, 32);
  fileHeader.writeUInt32LE(0, 36);

  const docInfo = pack([rec(16, 0, Buffer.alloc(26)), binData(1, 'svg', 2)]);
  const section0 = pack([
    ...para(0, { units: controlUnits(11, 'gso ') }),
    ctrlGso(),
    rec(TAG.SHAPE_COMPONENT, 2),
    picture(3, 1),
  ]);

  return buildCfbfContainer([
    { name: 'FileHeader', data: fileHeader },
    { name: 'DocInfo', data: docInfo },
    { name: 'BodyText', children: [{ name: 'Section0', data: section0 }] },
    { name: 'BinData', children: [{ name: 'BIN0001.svg', data: svgBytes }] },
  ]);
}

function ctrlGso() {
  const head = Buffer.from([' ', 'o', 's', 'g'].map((ch) => ch.charCodeAt(0)));
  return rec(TAG.CTRL_HEADER, 1, Buffer.concat([head, objectProperties(7200, 3600)]));
}

describe('P1-12: SVG sanitizer DOCTYPE quotes, CDATA/comment element skipping, and HWP SVG cap', () => {
  it('preserves valid XML when stripDoctype sees ]> and > inside quoted literals, comments, and PIs', () => {
    const doubleQuoted =
      '<!DOCTYPE svg [ <!ENTITY label "a]>b"> ]><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
    const cleanDouble = sanitizeSvgDocument(doubleQuoted);
    expect(cleanDouble).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect(parseXmlStrict(cleanDouble)).toEqual(['svg']);

    const singleQuotedWithCommentsAndPis =
      "<!DOCTYPE svg PUBLIC '-//W3C//EN' 'http://example.com/a>b' [ <!ENTITY note 'x]>y'> <!-- ]> --> <?pi ]> ?> ]>" +
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
    const cleanSingle = sanitizeSvgDocument(singleQuotedWithCommentsAndPis);
    expect(cleanSingle).toBe('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
    expect(parseXmlStrict(cleanSingle)).toEqual(['svg', 'rect']);

    const inertXmlText = '<svg xmlns="http://www.w3.org/2000/svg"><!-- <!DOCTYPE x> --><text><![CDATA[<!DOCTYPE z>]]></text></svg>';
    expect(sanitizeSvgDocument(inertXmlText)).toBe(inertXmlText);
    expect(parseXmlStrict(inertXmlText)).toEqual(['svg', 'text']);

    const attrText = '<svg xmlns="http://www.w3.org/2000/svg"><text title="<!DOCTYPE y>"/></svg>';
    expect(sanitizeSvgDocument(attrText)).toBe(attrText);
  });

  it('preserves valid XML when <script appears inside CDATA, comments, or quoted attributes', () => {
    const cdataPartialScript =
      '<svg xmlns="http://www.w3.org/2000/svg"><text><![CDATA[2 <script]]></text><rect width="1" height="1"/></svg>';
    const cleanPartial = sanitizeSvgDocument(cdataPartialScript);
    expect(cleanPartial).toBe(cdataPartialScript);
    expect(parseXmlStrict(cleanPartial)).toEqual(['svg', 'text', 'rect']);

    const inertContexts =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<text><![CDATA[<script>x</script>]]></text>' +
      '<!-- <script>alert(1)</script> -->' +
      '<rect data-note="benign"/>' +
      '</svg>';
    const cleanInert = sanitizeSvgDocument(inertContexts);
    expect(cleanInert).toBe(inertContexts);
    expect(parseXmlStrict(cleanInert)).toEqual(['svg', 'text', 'rect']);

    const quotedAttr = '<svg xmlns="http://www.w3.org/2000/svg"><rect data-code="<script>alert(1)</script>"/></svg>';
    expect(sanitizeSvgDocument(quotedAttr)).toBe(quotedAttr);
  });

  it('blocks XSS breakout attempts using CDATA/comments inside <script>, fake DOCTYPE quotes, and unclosed tags', () => {
    expect(sanitizeSvgString('<svg><script><![CDATA[ "</script>"; alert(1); ]]></script><rect/></svg>')).toBe('<svg><rect/></svg>');
    expect(sanitizeSvgString('<svg><script><!-- </script> -->alert(1)</script><rect/></svg>')).toBe('<svg><rect/></svg>');
    expect(sanitizeSvgString('<!DOCTYPE svg [ <!ENTITY x "]> <!--"> ]><script>alert(1)</script>--><svg/>')).toBe('--><svg/>');

    expect(sanitizeSvgString('<!DOCTYPE svg [ <!ENTITY x "unterminated><script>alert(1)</script><svg/>')).toBe('');
    expect(sanitizeSvgString('<!DOCTYPE svg [ <!-- unterminated><script>alert(1)</script><svg/>')).toBe('');
    expect(sanitizeSvgString('<!DOCTYPE svg [ <!ENTITY x "1"> ] bogus><svg><rect/></svg>')).toBe('');
    expect(sanitizeSvgString('<svg><rect <script>alert(1)</script></svg>')).toBe('<svg><rect </svg>');

    expect(isSvg('<!--><svg/>')).toBe(false);
    expect(isSvg('<!DOCTYPE svg [ <!ENTITY x "a]>b"> ]><svg/>')).toBe(true);
    expect(isSvg('<!DOCTYPE svg [ <!ENTITY x "<!--"> ]><svg/>')).toBe(true);
    expect(isSvg('<!DOCTYPE html SYSTEM "<!--"><html><script>alert(1)</script></html><!-- -->"><svg/>')).toBe(false);

    // Malformed / stray quotes and unclosed attribute tags must not hide <script> or <!DOCTYPE>.
    for (const payload of [
      '<svg><rect x=1"2><script>alert(1)</script></svg>',
      '<svg><rect x=1"2><script>alert(1)</script><rect y="3"/></svg>',
      '<svg><rect "><script>alert(1)</script></svg>',
      '<svg><rect x="unterminated><script>alert(1)</script></svg>',
      '<svg><rect =""><script>alert(1)</script></svg>',
      '<svg><scr<![CDATA[><script>alert(1)</script>]]></svg>',
      '<svg><rect <!-- ><script>alert(1)</script> --></svg>',
      '<svg><rect <?p ><script>alert(1)</script> ?>></svg>',
      '<svg></foo <!-- ><script>alert(1)</script> --></svg>',
      '<svg></foo <![CDATA[><script>alert(1)</script>]]></svg>',
      '<svg><!foo <!-- ><script>alert(1)</script> --></svg>',
      '<svg><!foo <![CDATA[><script>alert(1)</script>]]></svg>',
      '<svg><script>x</script <!-- ><script>alert(1)</script> --></svg>',
    ]) {
      const cleaned = sanitizeSvgDocument(payload);
      expect(cleaned).not.toContain('<script');
      expect(cleaned).not.toContain('alert(1)');
    }

    const endTagAttrs = sanitizeSvgDocument(
      '<svg></foo <!-- ><rect onload="alert(1)"/><a href="javascript:alert(1)">x</a> --></svg>'
    );
    expect(endTagAttrs).not.toContain('onload');
    expect(endTagAttrs).not.toContain('javascript:');
    expect(endTagAttrs).toContain('<a href="#">');

    const bogusEndTagPi = sanitizeSvgDocument(
      '<svg></ <!-- ><rect onload="alert(1)"/><?xml-stylesheet href="http://evil.test/x.css"?> --></svg>'
    );
    expect(bogusEndTagPi).not.toContain('onload');
    expect(bogusEndTagPi).not.toContain('xml-stylesheet');

    const endTagDoctype = sanitizeSvgDocument(
      '<svg></rect <!-- ><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><rect/> --></svg>'
    );
    expect(endTagDoctype).not.toContain('DOCTYPE');
    expect(endTagDoctype).not.toContain('ENTITY');
    expect(endTagDoctype).toContain('<rect/>');

    expect(sanitizeSvgDocument('<svg><script>/*</script"">*/alert(1)</script><rect/></svg>')).toBe('<svg><rect/></svg>');

    const strayDoctype = sanitizeSvgString('<svg x=1"2><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><rect/></svg>');
    expect(strayDoctype).not.toContain('DOCTYPE');
    expect(strayDoctype).not.toContain('ENTITY');
    expect(strayDoctype).toContain('<rect/>');

    expect(sanitizeSvgString('<?xml ><script>alert(1)</script> ?><svg/>')).toBe('<svg/>');
  });

  it('rejects HTML5 foreign-content breakout CDATA differentials while preserving valid SVG CDATA', () => {
    const differentials = [
      '<svg><p><![CDATA[><script>alert(1)</script>]]></p></svg>',
      '<svg><p><style><![CDATA[ </style><script>alert(1)</script> ]]></style></p></svg>',
      '<svg><br/><![CDATA[><script>alert(1)</script>]]></svg>',
      '<svg></p><![CDATA[><script>alert(1)</script>]]></svg>',
      '<![CDATA[><script>alert(1)</script>]]><svg/>',
      '<svg/><![CDATA[><script>alert(1)</script>]]>',
      '<s:svg xmlns:s="http://www.w3.org/2000/svg"><![CDATA[><script>alert(1)</script>]]></s:svg>',
      '<svg><desc><b><![CDATA[><script>alert(1)</script>]]></b></desc></svg>',
      '<svg><desc><div></desc><![CDATA[><script>alert(1)</script>]]></svg>',
      '<svg><desc><style><![CDATA[ </style><script>alert(1)</script> ]]></style></desc></svg>',
      '<svg><font color="red"><![CDATA[><script>alert(1)</script>]]></font></svg>',
      '<!foo <svg> ><![CDATA[><script>alert(1)</script>]]>',
      '</é <svg> ><![CDATA[><script>alert(1)</script>]]>',
    ];
    for (const payload of differentials) {
      expect(() => sanitizeSvgDocument(payload)).toThrow(SvgSanitizationError);
    }

    const withRemovedForeignObject =
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>ok</p></foreignObject>' +
      '<style><![CDATA[.c{fill:#123456}]]></style><rect class="c" width="2" height="2"/></svg>';
    const cleanForeign = sanitizeSvgDocument(withRemovedForeignObject);
    expect(cleanForeign).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[.c{fill:#123456}]]></style><rect class="c" width="2" height="2"/></svg>'
    );
    expect(parseXmlStrict(cleanForeign)).toEqual(['svg', 'style', 'rect']);

    const nonAsciiPrefix = sanitizeSvgDocument(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:é="http://www.w3.org/2000/svg">' +
        '<é:script>alert(1)</é:script><é:rect onload="alert(1)" width="2" height="2"/></svg>'
    );
    expect(nonAsciiPrefix).not.toContain('<é:script');
    expect(nonAsciiPrefix).not.toContain('onload');
    expect(parseXmlStrict(nonAsciiPrefix)).toEqual(['svg', 'é:rect']);
  });

  it('accepts a valid embedded HWP SVG and rejects oversized or empty-sanitized HWP SVGs via sanitizeSvgDocument in planTextPdfRoute', async () => {
    const validSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#224466"/></svg>',
      'utf-8'
    );
    const validHwp = buildHwpWithEmbeddedSvg(validSvg);
    const route = await planTextPdfRoute(validHwp, 'hwp', 'pdf', 'ok.hwp', undefined, { forceNative: true });
    expect(route?.preferNative).toBe(true);
    expect(route?.stagedHtml?.toString('utf-8')).toContain('data:image/png;base64,');

    const head = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/>';
    const tail = '</svg>';
    const padChars = MAX_SVG_INPUT_CHARS + 64 - head.length - tail.length;
    const oversizedCharsSvg = Buffer.from(`${head}${' '.repeat(padChars)}${tail}`, 'utf-8');
    const oversizedCharsHwp = buildHwpWithEmbeddedSvg(oversizedCharsSvg);
    const charErr = await planTextPdfRoute(oversizedCharsHwp, 'hwp', 'pdf', 'oversized-chars.hwp', undefined, { forceNative: true }).catch(
      (err: unknown) => err
    );
    expect(charErr).toBeInstanceOf(SvgSanitizationError);
    expect((charErr as Error).message).toBe(`SVG input exceeds the ${MAX_SVG_INPUT_CHARS}-character limit.`);

    const padBytes = MAX_SVG_INPUT_CHARS * 4 + 64 - head.length - tail.length;
    const oversizedBytesSvg = Buffer.from(`${head}${' '.repeat(padBytes)}${tail}`, 'utf-8');
    const oversizedBytesHwp = buildHwpWithEmbeddedSvg(oversizedBytesSvg);
    const byteErr = await planTextPdfRoute(oversizedBytesHwp, 'hwp', 'pdf', 'oversized-bytes.hwp', undefined, { forceNative: true }).catch(
      (err: unknown) => err
    );
    expect(byteErr).toBeInstanceOf(SvgSanitizationError);
    expect((byteErr as Error).message).toBe(`SVG input exceeds the ${MAX_SVG_INPUT_CHARS}-character limit.`);

    const emptyAfterSanitizeSvg = Buffer.from('<!DOCTYPE svg [<!ENTITY x "unterminated><svg/>', 'utf-8');
    const emptyAfterSanitizeHwp = buildHwpWithEmbeddedSvg(emptyAfterSanitizeSvg);
    const emptyErr = await planTextPdfRoute(emptyAfterSanitizeHwp, 'hwp', 'pdf', 'empty-after-sanitize.hwp', undefined, {
      forceNative: true,
    }).catch((err: unknown) => err);
    expect(emptyErr).toBeInstanceOf(SvgSanitizationError);
  });
});
