import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  NON_COMPLIANT_REPORT,
  NON_COMPLIANT_RULES,
  createValidatorScripts,
  withValidator,
  type ValidatorScripts,
} from './helpers/pdfa-route-harness';
import { convertToPdfA, verifyPdfA } from '../src/lib/conversions/pdf-postprocess';
import { EngineUnavailableError, PdfAValidationError, PdfPostprocessError } from '../src/lib/types';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 248).
runWithoutFileConfinement();

const COMPLIANT_REPORT = '{"report":{"jobs":[{"validationResult":[{"compliant":true}]}]}}';
const EXIT_STATUS = 2;
const SHORT_TIMEOUT_MS = 300;
const HANG_SECONDS = 30;
const UNPROCESSABLE_DETAIL = 'The PDF/A validator could not process the document.';
const SLOW_VALIDATOR_SECONDS = 1;
const PROBE_INTERVAL_MS = 20;
const MIN_PROBE_TICKS = 20;
const PROBE_SECRET_NAME = 'EASYCONVERT_PROBE_API_TOKEN';
const PROBE_SECRET_VALUE = 'probe-secret-value-1f3a';

let validators: ValidatorScripts;
let compliantReportFile: string;
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
  compliantReportFile = path.join(validators.dir, 'compliant.json');
  fs.writeFileSync(compliantReportFile, COMPLIANT_REPORT);
  pdfa2b = await identifiedPdf();
});

afterAll(() => {
  validators.dispose();
});

describe('validator execution', () => {
  it('keeps the report of a validator that exits non-zero for a non-compliant file', async () => {
    const validator = validators.printing('verapdf-noncompliant', NON_COMPLIANT_REPORT, 1);

    const error = await withValidator(validator, () => verifyPdfA(pdfa2b, 'pdfa-2b')).then(
      () => {
        throw new Error('verifyPdfA accepted a non-compliant report');
      },
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(PdfAValidationError);
    expect([...(error as PdfAValidationError).failedRules]).toEqual(NON_COMPLIANT_RULES);
  });

  it('keeps the event loop running while the validator works', async () => {
    const validator = validators.write(
      'verapdf-slow',
      `sleep ${SLOW_VALIDATOR_SECONDS}\ncat "${compliantReportFile}"`
    );
    let ticks = 0;
    const probe = setInterval(() => {
      ticks++;
    }, PROBE_INTERVAL_MS);
    try {
      await withValidator(validator, () => verifyPdfA(pdfa2b, 'pdfa-2b'));
    } finally {
      clearInterval(probe);
    }

    expect(ticks).toBeGreaterThanOrEqual(MIN_PROBE_TICKS);
  });

  it('runs the validator without the credentials of the server environment', async () => {
    const envDump = path.join(validators.dir, 'validator-env.txt');
    const validator = validators.write('verapdf-env', `env > "${envDump}"\ncat "${compliantReportFile}"`);
    process.env[PROBE_SECRET_NAME] = PROBE_SECRET_VALUE;
    try {
      await withValidator(validator, () => verifyPdfA(pdfa2b, 'pdfa-2b'));
    } finally {
      delete process.env[PROBE_SECRET_NAME];
    }

    const seen = fs.readFileSync(envDump, 'utf-8');
    expect(seen).not.toContain(PROBE_SECRET_VALUE);
    expect(seen).toContain('PATH=');
  });

  it('answers a typed 422 when the validator exits without a report on a document', async () => {
    const validator = validators.write('verapdf-no-report', `printf 'boom at %s\\n' "$0" >&2\nexit ${EXIT_STATUS}`);

    const run = withValidator(validator, () => verifyPdfA(pdfa2b, 'pdfa-2b'));

    await expect(run).rejects.toBeInstanceOf(PdfPostprocessError);
    await expect(run).rejects.not.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toThrow(UNPROCESSABLE_DETAIL);
  });

  it('answers a typed 422, not engine-unavailable, when the validator times out', async () => {
    const validator = validators.write('verapdf-hangs', `sleep ${HANG_SECONDS}`);

    const run = withValidator(validator, () => verifyPdfA(pdfa2b, 'pdfa-2b', { timeoutMs: SHORT_TIMEOUT_MS }));

    await expect(run).rejects.toBeInstanceOf(PdfPostprocessError);
    await expect(run).rejects.not.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toThrow(UNPROCESSABLE_DETAIL);
  });

  it('keeps the event loop running and strips server credentials while the converter works', async () => {
    const plainDoc = await PDFDocument.create();
    plainDoc.addPage([100, 100]);
    const sourcePdf = Buffer.from(await plainDoc.save());
    const convertedFile = path.join(validators.dir, 'converted-2b.pdf');
    fs.writeFileSync(convertedFile, pdfa2b);
    const marker = path.join(validators.dir, 'event-loop-marker');
    const envDump = path.join(validators.dir, 'converter-env.txt');
    const converter = validators.write(
      'soffice-event-loop',
      `env > "${envDump}"\n` +
        `i=0; while [ ! -f "${marker}" ] && [ "$i" -lt 50 ]; do sleep 0.02; i=$((i + 1)); done\n` +
        `[ -f "${marker}" ] || exit 1\n` +
        `out=""; prev=""; for a in "$@"; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; done; in="$a"\n` +
        `cp "${convertedFile}" "$out/$(basename "$in")"`
    );
    const validator = validators.printing('verapdf-compliant', COMPLIANT_REPORT, 0);
    const previousSoffice = process.env.SOFFICE_PATH;
    process.env.SOFFICE_PATH = converter;
    process.env[PROBE_SECRET_NAME] = PROBE_SECRET_VALUE;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await withValidator(validator, async () => {
        const conversion = convertToPdfA(sourcePdf, { conformance: 'pdfa-2b' });
        timer = setTimeout(() => {
          fs.writeFileSync(marker, 'ready');
        }, PROBE_INTERVAL_MS);
        return await conversion;
      });
      expect(result.pdfaValidated).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
      if (previousSoffice === undefined) delete process.env.SOFFICE_PATH;
      else process.env.SOFFICE_PATH = previousSoffice;
      delete process.env[PROBE_SECRET_NAME];
    }

    const seen = fs.readFileSync(envDump, 'utf-8');
    expect(seen).not.toContain(PROBE_SECRET_VALUE);
    expect(seen).toContain('SAL_USE_VCLPLUGIN=svp');
  });
});
