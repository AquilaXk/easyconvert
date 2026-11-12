import createClient, { type Client } from 'openapi-fetch';
import type { components, paths } from './generated/schema';

export type Schemas = components['schemas'];
export type ConversionOptions = Schemas['ConversionOptions'];
export type ConversionResponse = Schemas['ConversionResponse'];
export type JobDetails = Schemas['JobDetails'];
export type ProblemDetails = Schemas['ProblemDetails'];

const DEFAULT_BASE_URL = 'https://easyconvert.app';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60_000;
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export interface EasyConvertClientConfig {
  apiKey: string;
  baseUrl?: string;
  /** Per request, including a download. */
  timeoutMs?: number;
  /** A replacement for the global fetch, for tests or a proxy. */
  fetch?: typeof fetch;
}

export interface UploadParams {
  file: Blob;
  /** The file name sent with the upload; a Blob has none of its own unless it is a File. */
  filename?: string;
  targetFormat: string;
  sourceFormat?: string;
  options?: ConversionOptions;
  webhookUrl?: string;
  webhookSecret?: string;
}

/** The 202 of a conversion that was queued (a file over the synchronous limit): poll the job for the result. */
export interface ConversionAccepted {
  status: 'accepted';
  jobId: string;
  statusUrl: string;
}

export interface WaitForJobOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export class EasyConvertApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | undefined,
  ) {
    super(`EasyConvert API error (${status}): ${problem?.detail ?? problem?.title ?? 'request failed'}`);
    this.name = 'EasyConvertApiError';
  }
}

type FormValue = Blob | string | number | boolean | undefined;

/** multipart/form-data from an object: a Blob is sent as a file, anything else as text, `options` as its JSON. */
function multipartBody(fields: object, filename: string | undefined): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields) as [string, FormValue | object][]) {
    if (value === undefined) continue;
    if (value instanceof Blob) form.append(name, value, filename ?? (value instanceof File ? value.name : 'upload.bin'));
    else form.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return form;
}

/**
 * Hand-written convenience layer over the generated client: upload, poll a job, download the result. `api` is the full generated
 * surface, typed from `paths` of the OpenAPI document, for every other operation.
 */
export class EasyConvertClient {
  readonly api: Client<paths>;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: EasyConvertClientConfig) {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) throw new Error('EasyConvertClient needs an API key');
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.authorization = `Bearer ${apiKey}`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? fetch;
    this.api = createClient<paths>({
      baseUrl: this.baseUrl,
      headers: { Authorization: this.authorization },
      fetch: (request) => this.fetchImpl(request, { signal: AbortSignal.timeout(this.timeoutMs) }),
    });
  }

  /**
   * Converts a file. The answer is the result, or the queued job when the file is over the synchronous limit or `respondAsync` is
   * set (also with `raw`); a finished `raw` conversion answers the bytes of the result.
   */
  async convert(params: UploadParams & { respondAsync?: boolean; raw?: boolean }): Promise<ConversionResponse | ConversionAccepted | ArrayBuffer> {
    const { filename, respondAsync, raw, ...fields } = params;
    const { data, error, response } = await this.api.POST('/api/v1/convert', {
      params: { header: respondAsync ? { Prefer: 'respond-async' } : {}, query: raw ? { raw } : {} },
      // The generated type calls a binary part a string; bodySerializer turns the Blob into the part.
      body: { ...fields, file: fields.file as unknown as string, options: undefined },
      bodySerializer: () => multipartBody(fields, filename),
      // A queued conversion answers JSON even with raw, so the bytes are decoded below.
      parseAs: raw ? 'arrayBuffer' : 'json',
    });
    if (error !== undefined) throw new EasyConvertApiError(response.status, error as ProblemDetails);
    if (response.status === 202) {
      const accepted = raw ? JSON.parse(new TextDecoder().decode(data as ArrayBuffer)) : data;
      return { status: 'accepted', ...(accepted as Omit<ConversionAccepted, 'status'>) };
    }
    return data as ConversionResponse | ArrayBuffer;
  }

  /** Queues a conversion job for a file and returns its id; follow it with `waitForJob`. */
  async createJob(params: UploadParams): Promise<{ jobId: string; statusUrl: string }> {
    const { filename, ...fields } = params;
    const { data, error, response } = await this.api.POST('/api/v1/jobs', {
      body: { ...fields, file: fields.file as unknown as string, options: undefined },
      bodySerializer: () => multipartBody(fields, filename),
    });
    if (data === undefined || data.jobId === undefined || data.statusUrl === undefined) {
      throw new EasyConvertApiError(response.status, error as ProblemDetails | undefined);
    }
    return { jobId: data.jobId, statusUrl: data.statusUrl };
  }

  async getJob(jobId: string): Promise<JobDetails> {
    const { data, error, response } = await this.api.GET('/api/v1/jobs/{id}', { params: { path: { id: jobId } } });
    if (data === undefined) throw new EasyConvertApiError(response.status, error as ProblemDetails | undefined);
    return data;
  }

  /** Polls until the job completed, failed or was cancelled, and returns its last state; check `status`. */
  async waitForJob(jobId: string, options: WaitForJobOptions = {}): Promise<JobDetails> {
    const { intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = options;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.getJob(jobId);
      if (job.status !== undefined && TERMINAL_JOB_STATUSES.has(job.status)) return job;
      if (Date.now() + intervalMs > deadline) throw new Error(`Job ${jobId} did not finish within ${timeoutMs} ms (status ${job.status})`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /** Downloads the bytes of a finished conversion from the `downloadUrl` of its result. */
  async download(downloadUrl: string): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(new URL(downloadUrl, this.baseUrl), {
      headers: { Authorization: this.authorization },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(response.status, problem);
    }
    return response.arrayBuffer();
  }
}
