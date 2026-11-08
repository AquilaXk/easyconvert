import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { convertToPdfA } from '../src/lib/conversions/pdf-postprocess/pdfa';

/**
 * The PDF/A conversion starts the office suite as every other run of it does: with its home and temporary directory in the directory of the
 * job, which is removed with it, so nothing of the run lands in the home of the worker or in the shared temporary directory.
 */

let workDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

function script(name: string, body: string): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

async function pdfWithPdfAId(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]).drawText('archival', { x: 20, y: 100, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
  return Buffer.from(await doc.save());
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfa-office-environment-'));
});
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
});
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe('the office suite run of the PDF/A conversion', () => {
  it('has its home and temporary directory in the directory of the job', async () => {
    const converted = path.join(workDir, 'converted.pdf');
    fs.writeFileSync(converted, await pdfWithPdfAId());
    const report = path.join(workDir, 'environment.txt');
    setEnv(
      'SOFFICE_PATH',
      script(
        'soffice-environment',
        `out=""; prev=""; for a in "$@"; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; done\n` +
          `printf '%s\\n%s\\n%s\\n' "$HOME" "$TMPDIR" "$out" > "${report}"\n` +
          `cp "${converted}" "$out/source.pdf"`
      )
    );
    const verdict = path.join(workDir, 'verdict.json');
    fs.writeFileSync(verdict, JSON.stringify({ report: { jobs: [{ validationResult: [{ compliant: true, profileName: 'PDF/A-1B' }] }] } }));
    setEnv('VERAPDF_PATH', script('verapdf-passes', `cat "${verdict}"`));

    const input = await PDFDocument.create();
    input.addPage([300, 200]);
    await convertToPdfA(Buffer.from(await input.save()), { conformance: 'pdfa-1b' });

    const [home, temporary, outDir] = fs.readFileSync(report, 'utf8').trim().split('\n');
    const jobDir = path.dirname(outDir);
    expect(path.basename(outDir)).toBe('out');
    expect(path.basename(jobDir)).toMatch(/^easyconvert_pdfa_\d+_[0-9a-f]{16}$/);
    expect({ home, temporary }).toEqual({ home: jobDir, temporary: jobDir });
  });
});
