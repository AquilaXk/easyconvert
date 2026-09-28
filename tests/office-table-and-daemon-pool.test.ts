import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LibreOfficePoolManager } from '../src/worker/libreoffice-pool';
import { convertOffice, parseDocxXml, DocxTable } from '../src/lib/conversions/office';
import { createZipArchive } from '../src/lib/conversions/archive';

/**
 * Creates a synthetic minimal valid DOCX buffer with customized XML content.
 */
async function buildMockDocxWithTable(tableXml: string): Promise<Buffer> {
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Quarterly Financial Performance Overview</w:t></w:r></w:p>
    ${tableXml}
    <w:p><w:r><w:t>End of Report</w:t></w:r></w:p>
  </w:body>
</w:document>`;

  const files = [
    { filename: '[Content_Types].xml', buffer: Buffer.from(contentTypesXml, 'utf-8') },
    { filename: '_rels/.rels', buffer: Buffer.from(relsXml, 'utf-8') },
    { filename: 'word/document.xml', buffer: Buffer.from(documentXml, 'utf-8') },
  ];

  const zip = await createZipArchive(files, { compressionLevel: 0 }, 'doc.docx');
  return zip.buffer;
}

describe('Phase 4: Resident UNO Socket Pool & Dynamic Office Table Layout', () => {
  const activePools: LibreOfficePoolManager[] = [];

  afterEach(async () => {
    while (activePools.length > 0) {
      const pool = activePools.pop()!;
      await pool.shutdown();
    }
  });

  describe('1. Dynamic Table Layout with w:gridCol and w:gridSpan', () => {
    it('extracts proportional colWidths from w:gridCol elements in DOCX table', async () => {
      const tableXml = `
      <w:tbl>
        <w:tblGrid>
          <w:gridCol w:w="1500"/>
          <w:gridCol w:w="3000"/>
          <w:gridCol w:w="4500"/>
        </w:tblGrid>
        <w:tr>
          <w:tc><w:p><w:r><w:t>ID</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>Metric Name</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>Detailed Description</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>Throughput</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>High velocity processing engine</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>`;

      const parsed = parseDocxXml(tableXml);

      expect(parsed.tables).toHaveLength(1);
      const tbl = parsed.tables[0];
      expect(tbl.colWidths).toEqual([1500, 3000, 4500]);
      expect(tbl.colCount).toBe(3);
      expect(tbl.rowCount).toBe(2);
    });

    it('renders DOCX table with merged cells (w:gridSpan) and multi-line wrapping to PDF without crash', async () => {
      // Table with merged header cell (gridSpan = 2) and long text that wraps across multiple lines
      const longText = 'This is an extensive multi-line explanation of operating margins across APAC, EMEA, and Americas regions that will wrap nicely in the cell.';
      const tableXml = `
      <w:tbl>
        <w:tblGrid>
          <w:gridCol w:w="2000"/>
          <w:gridCol w:w="4000"/>
          <w:gridCol w:w="2000"/>
        </w:tblGrid>
        <w:tr>
          <w:tc>
            <w:tcPr><w:gridSpan w:val="2"/></w:tcPr>
            <w:p><w:r><w:t>Consolidated Revenue &amp; Expenses</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:p><w:r><w:t>Audit Status</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc>
            <w:p><w:r><w:t>Q3</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:p><w:r><w:t>${longText}</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:p><w:r><w:t>PASSED</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
      </w:tbl>`;

      const docxBuffer = await buildMockDocxWithTable(tableXml);
      const pdfResult = await convertOffice(docxBuffer, 'docx', 'pdf');

      expect(pdfResult).not.toBeNull();
      expect(pdfResult.buffer.length).toBeGreaterThan(500);
      expect(pdfResult.mimeType).toBe('application/pdf');
      // PDF header validation (%PDF-1.)
      expect(pdfResult.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });

    it('renders DOCX table to HTML with colSpan attributes and structural integrity', async () => {
      const tableXml = `
      <w:tbl>
        <w:tblGrid>
          <w:gridCol w:w="3000"/>
          <w:gridCol w:w="3000"/>
        </w:tblGrid>
        <w:tr>
          <w:tc>
            <w:tcPr><w:gridSpan w:val="2"/></w:tcPr>
            <w:p><w:r><w:t>Wide Header Cell</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:p><w:r><w:t>Col 1</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>Col 2</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>`;

      const docxBuffer = await buildMockDocxWithTable(tableXml);
      const htmlResult = await convertOffice(docxBuffer, 'docx', 'html');

      expect(htmlResult.buffer.length).toBeGreaterThan(100);
      const htmlString = htmlResult.buffer.toString('utf-8');
      expect(htmlString).toContain('colspan="2"');
      expect(htmlString).toContain('Wide Header Cell');
      expect(htmlString).toContain('Col 1');
      expect(htmlString).toContain('Col 2');
    });
  });

  describe('2. Resident UNO Socket Pool & Rolling Recycling', () => {
    it('initializes with daemonMode and 150 jobs max per worker recycling threshold', () => {
      const pool = new LibreOfficePoolManager({
        maxWorkers: 2,
        enabled: true,
      });
      activePools.push(pool);

      const stats = pool.getStats();
      expect(stats.daemonMode).toBe(true);
      expect(stats.maxJobsPerWorker).toBe(150);
    });

    it('assigns isolated UNO socket ports and includes --accept argument in executor calls', async () => {
      const recordedCalls: Array<{ bin: string; args: string[] }> = [];
      const mockExecutor = vi.fn(async (bin: string, args: string[], opts?: any) => {
        recordedCalls.push({ bin, args });
        const cwd = opts?.cwd;
        if (cwd && fs.existsSync(cwd)) {
          fs.writeFileSync(path.join(cwd, 'input.pdf'), Buffer.from('%PDF-1.7 mock output'));
        }
        return {
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          exitCode: 0,
          durationMs: 10,
          sandboxed: true,
          sandboxType: 'host' as const,
        };
      });

      const pool = new LibreOfficePoolManager({
        maxWorkers: 1,
        minWorkers: 1,
        sofficePath: '/usr/bin/soffice',
        enabled: true,
        executor: mockExecutor,
        daemonMode: true,
      });
      activePools.push(pool);

      await pool.init();

      // Pre-warm call: should include --accept=socket,host=127.0.0.1,port=2002;urp;
      expect(recordedCalls.length).toBeGreaterThanOrEqual(1);
      const prewarm = recordedCalls[0];
      expect(prewarm.args.some((a) => a.startsWith('--accept=socket,host=127.0.0.1,port='))).toBe(true);

      // Conversion call: should also include --accept=socket...
      const result = await pool.convert(Buffer.from('doc content'), 'docx', 'pdf');
      expect(result).not.toBeNull();

      expect(recordedCalls.length).toBeGreaterThanOrEqual(2);
      const conv = recordedCalls[1];
      expect(conv.args.some((a) => a.startsWith('--accept=socket,host=127.0.0.1,port='))).toBe(true);
      expect(conv.args).toContain('--convert-to');
      expect(conv.args).toContain('pdf');
    });

    it('triggers rolling recycling when a worker reaches maxJobsPerWorker threshold', async () => {
      const mockExecutor = vi.fn(async (_bin: string, _args: string[], opts?: any) => {
        const cwd = opts?.cwd;
        if (cwd && fs.existsSync(cwd)) {
          fs.writeFileSync(path.join(cwd, 'input.pdf'), Buffer.from('%PDF-1.7 mock output'));
        }
        return {
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          exitCode: 0,
          durationMs: 5,
          sandboxed: true,
          sandboxType: 'host' as const,
        };
      });

      // Set maxJobsPerWorker = 3 to test recycling deterministically
      const pool = new LibreOfficePoolManager({
        maxWorkers: 1,
        minWorkers: 1,
        maxJobsPerWorker: 3,
        sofficePath: '/usr/bin/soffice',
        enabled: true,
        executor: mockExecutor,
      });
      activePools.push(pool);

      await pool.init();

      // Acquire worker and inspect initial ID
      const initialWorker = await pool.acquireWorker();
      const initialId = initialWorker.id;
      await pool.releaseWorker(initialWorker); // jobCount = 1

      const w2 = await pool.acquireWorker();
      expect(w2.id).toBe(initialId);
      await pool.releaseWorker(w2); // jobCount = 2

      const w3 = await pool.acquireWorker();
      expect(w3.id).toBe(initialId);
      await pool.releaseWorker(w3); // jobCount = 3 -> triggers recycle!

      // Worker should have been recycled and replaced with a fresh instance
      const wFresh = await pool.acquireWorker();
      expect(wFresh.id).not.toBe(initialId);
      expect(wFresh.jobCount).toBe(0);
      await pool.releaseWorker(wFresh);
    });
  });
});
