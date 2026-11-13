import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requiresNativeEngine } from '../src/lib/conversions/native-engine-pairs';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { bridgeFormat, convertBridgedTarget, type OfficeSuiteRequest, type OfficeSuiteRouteDeps } from '../src/worker/office-suite-route';
import type { WorkerConversionResult } from '../src/worker/worker-types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * A PDF is written as PowerPoint 97-2003 (`.ppt`) the way it is written as Word 97-2003: the in-process converter writes the PDF as the
 * presentation of its pages (one slide for each page, entry 281) and the office suite exports that file with its own PowerPoint 97 filter.
 */

const FIXTURES = path.join(__dirname, 'fixtures');
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const SOFFICE_TIMEOUT_MS = 240_000;
const ROUND_TRIP_TEST_TIMEOUT_MS = 300_000;

function written(overrides: Partial<WorkerConversionResult> = {}): WorkerConversionResult {
  const buffer = Buffer.from('converted bytes');
  return { buffer, mimeType: 'application/octet-stream', filename: 'out.bin', size: buffer.length, engineUsed: 'native-soffice-pool', executionTimeMs: 1, ...overrides };
}

function standIns(): { deps: OfficeSuiteRouteDeps; converted: { src: string; target: string }[]; exported: { src: string; target: string; options: object }[]; discarded: (string | undefined)[] } {
  const converted: { src: string; target: string }[] = [];
  const exported: { src: string; target: string; options: object }[] = [];
  const discarded: (string | undefined)[] = [];
  const deps: OfficeSuiteRouteDeps = {
    async writeWithOfficeSuite(_input, src, target, options) {
      exported.push({ src, target, options });
      return written({ filePath: '/out/deck.ppt' });
    },
    async convert(_input, src, target) {
      converted.push({ src, target });
      return written({ buffer: Buffer.from('the presentation'), filePath: '/tmp/deck.pptx', engineUsed: 'internal-fallback' });
    },
    discardOutput(filePath) {
      discarded.push(filePath);
    },
  };
  return { deps, converted, exported, discarded };
}

const request = (overrides: Partial<OfficeSuiteRequest> = {}): OfficeSuiteRequest => ({ input: Buffer.from('%PDF-'), src: 'pdf', tgt: 'ppt', options: {}, originalFilename: 'deck.pdf', ...overrides });

describe('PDF to PPT is offered and routed through the presentation of its pages', () => {
  it('is advertised, as the reference service lists it, and needs the office suite', () => {
    expect(FORMAT_REGISTRY.pdf.targetFormats).toContain('ppt');
    const reference = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'reference-formats.json'), 'utf8')) as { input_format: string; output_format: string }[];
    expect(reference.some((pair) => pair.input_format === 'pdf' && pair.output_format === 'ppt')).toBe(true);
    expect(requiresNativeEngine('pdf', 'ppt')).toBe(true);
  });

  it('names the PPTX as the file written first, and leaves the other PDF routes as they were', () => {
    expect(bridgeFormat('pdf', 'ppt')).toBe('pptx');
    expect(bridgeFormat('pdf', 'doc')).toBe('docx');
    expect(bridgeFormat('pdf', 'pptx')).toBeUndefined();
    expect(bridgeFormat('docx', 'ppt')).toBeUndefined();
  });

  it('writes the PPTX in process, exports it with the office suite and removes the PPTX', async () => {
    const { deps, converted, exported, discarded } = standIns();
    const answer = await convertBridgedTarget(deps, request(), async () => written({ engineUsed: 'internal-fallback' }));
    expect(answer.filePath).toBe('/out/deck.ppt');
    expect(converted).toEqual([{ src: 'pdf', target: 'pptx' }]);
    expect(exported).toMatchObject([{ src: 'pptx', target: 'ppt', options: { throwOnUnavailable: true } }]);
    expect(discarded).toEqual(['/tmp/deck.pptx']);
  });
});

describe('LibreOffice reads the result', () => {
  oracleTest(
    'the PPT is a PowerPoint 97 file of as many slides as the PDF has pages, with its words',
    ['soffice', 'pdftotext', 'pdfinfo'],
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ppt-'));
      try {
        const source = path.join(__dirname, 'fixtures', 'pdf-text', 'multipage.pdf');
        const result = await dispatchConversion(fs.readFileSync(source), 'pdf', 'ppt', {}, 'multipage.pdf');
        expect(result.buffer.subarray(0, COMPOUND_FILE_SIGNATURE.length).equals(COMPOUND_FILE_SIGNATURE)).toBe(true);
        fs.writeFileSync(path.join(dir, 'multipage.ppt'), result.buffer);
        execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'multipage.ppt')], {
          timeout: SOFFICE_TIMEOUT_MS,
          stdio: 'ignore',
        });
        const pagesOf = (file: string): string => /Pages:\s+(\d+)/.exec(execFileSync(requireOracleTool('pdfinfo'), [file], { encoding: 'utf8' }))?.[1] ?? '';
        expect(pagesOf(path.join(dir, 'multipage.pdf'))).toBe(pagesOf(source));
        const text = (file: string): string[] => execFileSync(requireOracleTool('pdftotext'), ['-raw', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8' }).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        const drawn = new Set(text(path.join(dir, 'multipage.pdf')));
        expect(text(source).filter((word) => !drawn.has(word))).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ROUND_TRIP_TEST_TIMEOUT_MS
  );
});
