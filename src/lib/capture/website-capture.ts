import fs from 'node:fs';
import path from 'node:path';
import { startCaptureGate, type CaptureGateOptions } from '../security/capture-gate';
import { assertPublicOutboundUrl, OutboundRequestBlockedError } from '../security/safe-fetch';
import {
  rethrowSandboxUnavailable,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  withWorkerSandbox,
} from '../../worker/sandbox';
import { CpuTaskTimeoutError, EngineUnavailableError, type ConversionOptions } from '../types';
import { captureUrlProblem } from '../jobs/capture-url';
import { websiteCaptureEnabled } from './capture-enabled';
import { CaptureFailedError, CaptureTargetBlockedError, CaptureUnavailableError } from './website-capture-errors';

/**
 * Website capture: a public page as a PDF, a PNG or a JPEG, drawn by Chromium as Qt WebEngine, which the worker image already carries
 * (calibre depends on it; nothing is added to the image). The browser runs as a separate sandboxed process of the driver
 * `native/capture-website/capture.py` (Python with PyQt6, the interpreter and the bindings of the image), and its only route to the
 * network is the gate proxy of `capture-gate.ts`: the navigation, every redirect it follows and every subresource, frame, fetch and
 * WebSocket the page makes pass the SSRF checks of the project, with the address pinned to the one that was checked.
 *
 * The first address is also refused before a browser is started (`assertPublicOutboundUrl`, ports 80 and 443 only, no credentials in
 * the URL), so a request for a private address costs nothing. A page that cannot be loaded because the gate refused a hop of its
 * own navigation (a redirect to an internal address) is answered as blocked, not as a failed load.
 */

export const CAPTURE_FORMATS: ReadonlySet<string> = new Set(['pdf', 'png', 'jpg']);

const DRIVER_FILE_NAME = 'capture.py';
const PYTHON_VARIABLE = 'CAPTURE_PYTHON_PATH';
const DRIVER_VARIABLE = 'CAPTURE_DRIVER_PATH';
const PYTHON_CANDIDATES = ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'];
/** Where the worker image puts the driver; a checkout runs the one in `native/`. */
const DRIVER_CANDIDATES = ['/usr/local/lib/easyconvert/capture-website.py', path.resolve(process.cwd(), 'native', 'capture-website', DRIVER_FILE_NAME)];
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;
/** Time beyond the page's own limit for the browser to start and to write the file before the process is stopped. */
const PROCESS_GRACE_MS = 20_000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
/** Chromium reserves tens of GiB of address space and uses a few hundred MiB; the limit only stops a runaway mapping. */
const ADDRESS_SPACE_BYTES = 192 * 1024 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const MIME_TYPES: Readonly<Record<string, string>> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg' };

export type CaptureOptions = NonNullable<ConversionOptions['capture']>;

export interface WebsiteCaptureRequest {
  url: string;
  format: string;
  options?: CaptureOptions;
  signal?: AbortSignal;
  /** The time the page has to load and be drawn, in milliseconds. */
  timeoutMs?: number;
  /** Parts of the gate that a test replaces. Nothing in the product passes it. */
  gate?: CaptureGateOptions;
}

export interface WebsiteCaptureResult {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  /** The URL the page ended on after its redirects. */
  finalUrl: string;
  title: string;
  /** What the capture left out, one line each. */
  warnings: string[];
}

function resolveProgram(variable: string, candidates: readonly string[]): string | null {
  const named = process.env[variable];
  if (named !== undefined) return named !== '' && fs.existsSync(named) ? named : null;
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * Refuses a URL the capture will not load, before anything starts: a scheme other than http and https, credentials in the address,
 * a port other than 80 and 443, or a host that is not public now (the gate checks again for every request the browser makes).
 */
export async function assertCaptureUrl(raw: string): Promise<URL> {
  const problem = captureUrlProblem(raw);
  if (problem !== undefined) throw new CaptureTargetBlockedError(problem);
  const url = new URL(raw);
  try {
    await assertPublicOutboundUrl(url.href);
  } catch (error) {
    if (error instanceof OutboundRequestBlockedError) throw new CaptureTargetBlockedError(`The address of ${url.origin} is not a public one, so it cannot be captured.`);
    throw error;
  }
  return url;
}

interface DriverReport {
  ok: boolean;
  output?: string;
  finalUrl?: string;
  title?: string;
  blocked?: string[];
  code?: string;
  detail?: string;
}

function parseReport(stdout: string): DriverReport {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  try {
    const parsed = JSON.parse(line) as DriverReport;
    return typeof parsed === 'object' && parsed !== null ? parsed : { ok: false, code: 'capture_failed' };
  } catch {
    return { ok: false, code: 'capture_failed', detail: 'The browser gave no result.' };
  }
}

function hasMagic(file: Buffer, format: string): boolean {
  const magic = { pdf: PDF_MAGIC, png: PNG_MAGIC, jpg: JPEG_MAGIC }[format];
  return magic !== undefined && file.length >= magic.length && file.subarray(0, magic.length).equals(magic);
}

/** The environment of the browser: every directory it writes is inside the directory of this capture. */
function browserEnvironment(dir: string): Record<string, string> {
  const dirs = Object.fromEntries(['home', 'config', 'cache', 'runtime'].map((name) => [name, path.join(dir, name)]));
  for (const created of Object.values(dirs)) fs.mkdirSync(created, { mode: 0o700 });
  return {
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_DATA_HOME: dirs.home,
    XDG_RUNTIME_DIR: dirs.runtime,
    QT_QPA_PLATFORM: 'offscreen',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  };
}

/**
 * Captures `request.url` as `request.format`. Throws CaptureTargetBlockedError (422) for an address that is not public (the first one, or
 * a hop of the navigation), CaptureFailedError (422) for a page that cannot be loaded or drawn, CpuTaskTimeoutError (422) past the time
 * limit, and EngineUnavailableError (503) on a worker without the browser.
 */
export async function captureWebsite(request: WebsiteCaptureRequest): Promise<WebsiteCaptureResult> {
  const format = request.format;
  if (!websiteCaptureEnabled()) throw new CaptureUnavailableError();
  if (!CAPTURE_FORMATS.has(format)) throw new CaptureFailedError(`A page is captured as pdf, png or jpg, not "${format}".`);
  return runCapture(await assertCaptureUrl(request.url), request);
}

/** The capture of an address that has been checked: the browser, the gate and the report. Exported for the test of the real browser on a machine of its own. */
export async function runCapture(url: URL, request: WebsiteCaptureRequest): Promise<WebsiteCaptureResult> {
  const format = request.format;
  const python = resolveProgram(PYTHON_VARIABLE, PYTHON_CANDIDATES);
  const driver = resolveProgram(DRIVER_VARIABLE, DRIVER_CANDIDATES);
  if (python === null || driver === null) throw new EngineUnavailableError('capture-website', 'The browser driver or its Python interpreter is not installed.');

  const timeoutMs = Math.min(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const gate = await startCaptureGate(request.gate);
  try {
    return await withWorkerSandbox(
      async (sandbox) => {
        const outputName = `capture.${format}`;
        const requestFile = path.join(sandbox.sandboxDir, 'request.json');
        fs.writeFileSync(requestFile, JSON.stringify({ ...request.options, url: url.href, format, proxyPort: gate.port, timeoutMs, output: outputName }));
        let stdout: string;
        try {
          const run = await sandbox.execute(python, ['-I', driver, requestFile], {
            timeoutMs: timeoutMs + PROCESS_GRACE_MS,
            maxBuffer: MAX_STDOUT_BYTES,
            maxFileSize: MAX_OUTPUT_BYTES,
            rlimits: { asBytes: ADDRESS_SPACE_BYTES },
            env: browserEnvironment(sandbox.sandboxDir),
            // The browser reaches the network through the gate on the loopback interface, which a network namespace of its own would hide, so it
            // keeps the network of the worker and takes every other protection of a run: user and PID namespaces, the file confinement, the limits.
            networkIsolated: false,
            sandboxOptions: { keepNetwork: true },
            readDirs: [driver],
            signal: request.signal,
          });
          stdout = run.stdout.toString('utf-8');
        } catch (error) {
          rethrowSandboxUnavailable(error);
          if (error instanceof SandboxedTimeoutError) throw new CpuTaskTimeoutError('website capture', timeoutMs);
          if (error instanceof SandboxedBufferLimitError || error instanceof SandboxedMemoryLimitError) throw new CaptureFailedError('The page used more output or memory than a capture may.');
          if (error instanceof SandboxedProcessError) throw new CaptureFailedError('The browser stopped before it drew the page.');
          throw error;
        }
        return finish(parseReport(stdout), sandbox.sandboxDir, format, gate.refusals, url, timeoutMs);
      },
      { networkIsolated: false }
    );
  } finally {
    await gate.close();
  }
}

/** Whether the gate refused the address or the port of a request, as against a limit or a failure to connect. */
function isAddressRefusal(refusal: { reason: string }): boolean {
  return refusal.reason === 'blocked' || refusal.reason === 'port';
}

function finish(report: DriverReport, dir: string, format: string, refusals: ReadonlyArray<{ host: string; port: number; reason: string }>, url: URL, timeoutMs: number): WebsiteCaptureResult {
  if (!report.ok) {
    if (report.code === 'timeout') throw new CpuTaskTimeoutError('website capture', timeoutMs);
    // A page whose own navigation was refused at a hop (a redirect to an internal address) did not fail to load: it was blocked.
    const navigation = refusals.find(isAddressRefusal);
    if (report.code === 'load_failed' && navigation) {
      throw new CaptureTargetBlockedError(`The page, or a redirect of it, points at ${navigation.host}:${navigation.port}, which is not a public web address.`);
    }
    throw new CaptureFailedError(report.code === 'load_failed' ? `The page at ${url.origin} could not be loaded.` : `The page at ${url.origin} could not be drawn.`);
  }
  const file = path.join(dir, path.basename(report.output ?? `capture.${format}`));
  if (!fs.existsSync(file)) throw new CaptureFailedError('The browser wrote no file.');
  const buffer = fs.readFileSync(file);
  if (!hasMagic(buffer, format)) throw new CaptureFailedError(`The browser wrote a file that is not a ${format.toUpperCase()}.`);
  const warnings: string[] = [];
  const blocked = refusals.filter(isAddressRefusal);
  if (blocked.length > 0) warnings.push(`${blocked.length} request(s) of the page to addresses that are not public were refused and left out.`);
  if (report.blocked && report.blocked.length > 0) warnings.push(`${report.blocked.length} request(s) of the page for a resource that is not on the web (file, ftp, ...) were refused.`);
  return {
    buffer,
    mimeType: MIME_TYPES[format],
    filename: `${safeName(url)}.${format}`,
    finalUrl: report.finalUrl ?? url.href,
    title: report.title ?? '',
    warnings,
  };
}

/** A file name from the host and path of the URL: letters, digits, dots and dashes only. */
function safeName(url: URL): string {
  const base = `${url.hostname}${url.pathname}`.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return base === '' ? 'capture' : base;
}
