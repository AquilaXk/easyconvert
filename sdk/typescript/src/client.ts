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
  private readonly baseOrigin: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: EasyConvertClientConfig) {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) throw new Error('EasyConvertClient needs an API key');
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.baseOrigin = new URL(this.baseUrl).origin;
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

  /**
   * Downloads the bytes of a finished conversion from the `downloadUrl` of its result. The API key goes only to the origin of the
   * base URL: a link to another origin (a result held in storage of its own) is fetched without it.
   */
  async download(downloadUrl: string): Promise<ArrayBuffer> {
    const url = new URL(downloadUrl, this.baseUrl);
    const response = await this.fetchImpl(url, {
      headers: url.origin === this.baseOrigin ? { Authorization: this.authorization } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(response.status, problem);
    }
    return response.arrayBuffer();
  }

  /** Queues a graph processing job and returns its id and status url. */
  async createGraphJob(params: {
    graph: Record<string, unknown> | string;
    webhookUrl?: string;
    webhookSecret?: string;
  }): Promise<{ jobId: string; statusUrl: string }> {
    const graphObj = typeof params.graph === 'string' ? JSON.parse(params.graph) : params.graph;
    const body = {
      graph: graphObj,
      webhookUrl: params.webhookUrl,
      webhookSecret: params.webhookSecret,
    };
    const response = await this.fetchImpl(new URL('/api/v1/jobs', this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(response.status, problem);
    }
    const data = (await response.json()) as { jobId: string; statusUrl: string };
    return { jobId: data.jobId, statusUrl: data.statusUrl };
  }

  /** Resumable upload via TUS 1.0 protocol in chunks. */
  async uploadTus(
    file: Blob,
    options: { filename?: string; mimeType?: string; chunkSize?: number } = {},
  ): Promise<{ uploadId: string; storageKey?: string; location: string }> {
    const totalSize = file.size;
    const metadataParts: string[] = [];
    const filename = options.filename ?? (file instanceof File ? file.name : 'upload.bin');
    const toB64 = (s: string) => (typeof btoa !== 'undefined' ? btoa(s) : Buffer.from(s).toString('base64'));
    metadataParts.push(`filename ${toB64(filename)}`);
    if (options.mimeType || file.type) {
      metadataParts.push(`filetype ${toB64(options.mimeType || file.type)}`);
    }

    const initRes = await this.fetchImpl(new URL('/api/v1/uploads', this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: this.authorization,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(totalSize),
        'Upload-Metadata': metadataParts.join(','),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!initRes.ok && initRes.status !== 201) {
      const problem = (await initRes.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(initRes.status, problem);
    }
    const location = initRes.headers.get('Location') || '';
    const uploadId = location.split('/').pop() || '';
    let storageKey = initRes.headers.get('Storage-Key') || undefined;

    const chunkSize = options.chunkSize ?? 5 * 1024 * 1024;
    let offset = 0;
    while (offset < totalSize) {
      const end = Math.min(offset + chunkSize, totalSize);
      const chunk = file.slice(offset, end);
      const patchUrl = new URL(location, this.baseUrl);
      const patchRes = await this.fetchImpl(patchUrl, {
        method: 'PATCH',
        headers: {
          Authorization: this.authorization,
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: chunk,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!patchRes.ok && patchRes.status !== 204) {
        const problem = (await patchRes.json().catch(() => undefined)) as ProblemDetails | undefined;
        throw new EasyConvertApiError(patchRes.status, problem);
      }
      const newOffset = patchRes.headers.get('Upload-Offset');
      offset = newOffset ? parseInt(newOffset, 10) : end;
      if (patchRes.headers.get('Storage-Key')) {
        storageKey = patchRes.headers.get('Storage-Key') || undefined;
      }
    }
    return { uploadId, storageKey, location };
  }

  /** Direct multipart upload via presigned / direct upload URLs. */
  async uploadMultipart(
    file: Blob,
    options: { filename?: string; partSize?: number } = {},
  ): Promise<{ storageKey: string; uploadId: string }> {
    const filename = options.filename ?? (file instanceof File ? file.name : 'upload.bin');
    const initRes = await this.fetchImpl(new URL('/api/v1/uploads/direct', this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename,
        totalSize: file.size,
        partSize: options.partSize,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!initRes.ok) {
      const problem = (await initRes.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(initRes.status, problem);
    }
    const initData = (await initRes.json()) as {
      uploadId: string;
      storageKey: string;
      partSize: number;
      partUrls: Array<{ partNumber: number; url: string }>;
    };

    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (const partInfo of initData.partUrls) {
      const start = (partInfo.partNumber - 1) * initData.partSize;
      const end = Math.min(start + initData.partSize, file.size);
      const chunk = file.slice(start, end);
      const putRes = await this.fetchImpl(new URL(partInfo.url, this.baseUrl), {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.size),
        },
        body: chunk,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!putRes.ok) {
        throw new EasyConvertApiError(putRes.status, undefined);
      }
      const etag = putRes.headers.get('ETag') || `"${partInfo.partNumber}"`;
      parts.push({ partNumber: partInfo.partNumber, etag });
    }

    const completeRes = await this.fetchImpl(new URL('/api/v1/uploads/direct/complete', this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uploadId: initData.uploadId,
        parts,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!completeRes.ok) {
      const problem = (await completeRes.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(completeRes.status, problem);
    }
    const completeData = (await completeRes.json()) as { storageKey?: string };
    return { storageKey: completeData.storageKey ?? initData.storageKey, uploadId: initData.uploadId };
  }

  /** Inspects archive structure and encryption without unpacking. */
  async inspectArchive(
    params: { file?: Blob; storageKey?: string; filename?: string; password?: string },
  ): Promise<Record<string, unknown>> {
    let res: Response;
    if (params.file) {
      const formData = new FormData();
      formData.append('file', params.file, params.filename ?? (params.file instanceof File ? params.file.name : 'archive.zip'));
      if (params.password) formData.append('password', params.password);
      res = await this.fetchImpl(new URL('/api/v1/archive/inspect', this.baseUrl), {
        method: 'POST',
        headers: { Authorization: this.authorization },
        body: formData,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } else if (params.storageKey) {
      res = await this.fetchImpl(new URL('/api/v1/archive/inspect', this.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: this.authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          storageKey: params.storageKey,
          filename: params.filename,
          password: params.password,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } else {
      throw new Error('inspectArchive requires either file or storageKey');
    }
    if (!res.ok) {
      const problem = (await res.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(res.status, problem);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /** Registers encrypted storage credentials. */
  async createCredential(params: {
    providerType: 's3' | 'sftp';
    credentials: Record<string, unknown>;
    name?: string;
    ttlSeconds?: number;
  }): Promise<{ credentialRef: string; providerType: string; name?: string; expiresAt?: number }> {
    const res = await this.fetchImpl(new URL('/api/v1/storage/credentials', this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(res.status, problem);
    }
    return (await res.json()) as { credentialRef: string; providerType: string; name?: string; expiresAt?: number };
  }

  /** Lists registered storage credentials (references only). */
  async listCredentials(): Promise<{ credentials: Array<Record<string, unknown>> }> {
    const res = await this.fetchImpl(new URL('/api/v1/storage/credentials', this.baseUrl), {
      method: 'GET',
      headers: { Authorization: this.authorization },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(res.status, problem);
    }
    return (await res.json()) as { credentials: Array<Record<string, unknown>> };
  }

  /** Deletes registered storage credentials by reference. */
  async deleteCredential(id: string): Promise<void> {
    const res = await this.fetchImpl(new URL(`/api/v1/storage/credentials/${encodeURIComponent(id)}`, this.baseUrl), {
      method: 'DELETE',
      headers: { Authorization: this.authorization },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(res.status, problem);
    }
  }

  /** Verifies incoming HMAC-SHA256 webhook signature. */
  static async verifyWebhookSignature(
    payload: string,
    signature: string,
    timestamp: number,
    secret: string,
    toleranceSeconds = 300,
  ): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      return false;
    }
    const cleanSig = signature.replace(/^sha256=/, '').trim();
    const message = `${timestamp}.${payload}`;
    let expectedHex = '';
    if (typeof globalThis.crypto?.subtle !== 'undefined') {
      const enc = new TextEncoder();
      const key = await globalThis.crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sigBuffer = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message));
      expectedHex = Array.from(new Uint8Array(sigBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } else {
      try {
        const cryptoMod = await import('node:crypto');
        expectedHex = cryptoMod.createHmac('sha256', secret).update(message).digest('hex');
      } catch {
        return false;
      }
    }
    if (cleanSig.length !== expectedHex.length) return false;
    let mismatch = 0;
    for (let i = 0; i < cleanSig.length; i++) {
      mismatch |= cleanSig.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    return mismatch === 0;
  }
}
