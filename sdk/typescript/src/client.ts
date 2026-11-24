import createClient, { type Client } from 'openapi-fetch';
import type { components, paths } from './generated/schema';

export type Schemas = components['schemas'];
export type ConversionOptions = Schemas['ConversionOptions'];
export type ConversionResponse = Schemas['ConversionResponse'];
export type JobDetails = Schemas['JobDetails'];
export type ProblemDetails = Schemas['ProblemDetails'];

export const DEFAULT_BASE_URL = 'https://convert.aquilaxk.site';
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
  idempotencyKey?: string;
}

export interface VerifyWebhookOptions {
  toleranceSeconds?: number;
  deliveryId?: string;
  webhookId?: string;
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
    const { filename, respondAsync, raw, idempotencyKey, ...fields } = params;
    const header: Record<string, string> = {};
    if (respondAsync) header.Prefer = 'respond-async';
    if (idempotencyKey) header['Idempotency-Key'] = idempotencyKey;
    const { data, error, response } = await this.api.POST('/api/v1/convert', {
      params: { header, query: raw ? { raw } : {} },
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
    const { filename, idempotencyKey, ...fields } = params;
    const { data, error, response } = await this.api.POST('/api/v1/jobs', {
      ...(idempotencyKey ? { params: { header: { 'Idempotency-Key': idempotencyKey } } } : {}),
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
    const response = await this.fetchDownloadResponse(downloadUrl);
    return response.arrayBuffer();
  }

  /** Streams the bytes of a finished conversion from the `downloadUrl` without full memory buffering. */
  async downloadStream(downloadUrl: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.fetchDownloadResponse(downloadUrl);
    if (!response.body) {
      throw new Error('Download response did not include a readable body stream.');
    }
    return response.body;
  }

  private async fetchDownloadResponse(downloadUrl: string): Promise<Response> {
    const url = new URL(downloadUrl, this.baseUrl);
    const response = await this.fetchImpl(url, {
      headers: url.origin === this.baseOrigin ? { Authorization: this.authorization } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(response.status, problem);
    }
    return response;
  }

  /** Queues a graph processing job and returns its id and status url. */
  async createGraphJob(params: {
    graph: Record<string, unknown> | string;
    webhookUrl?: string;
    webhookSecret?: string;
    idempotencyKey?: string;
  }): Promise<{ jobId: string; statusUrl: string }> {
    const graphObj = typeof params.graph === 'string' ? JSON.parse(params.graph) : params.graph;
    const body = {
      graph: graphObj,
      webhookUrl: params.webhookUrl,
      webhookSecret: params.webhookSecret,
    };
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      'Content-Type': 'application/json',
    };
    if (params.idempotencyKey) {
      headers['Idempotency-Key'] = params.idempotencyKey;
    }
    const response = await this.fetchImpl(new URL('/api/v1/jobs', this.baseUrl), {
      method: 'POST',
      headers,
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
    const toB64 = encodeUtf8Base64;
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
    let storageKey = extractTusStorageKey(initRes.headers);

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
      const patchStorageKey = extractTusStorageKey(patchRes.headers);
      if (patchStorageKey) {
        storageKey = patchStorageKey;
      }
    }
    return { uploadId, storageKey, location };
  }

  private async presignMultipartPart(uploadId: string, key: string | undefined, partNumber: number): Promise<string> {
    const presignRes = await this.fetchImpl(new URL('/api/v1/uploads?action=presign', this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uploadId,
        ...(key ? { key } : {}),
        partNumber,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!presignRes.ok) {
      const problem = (await presignRes.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new EasyConvertApiError(presignRes.status, problem);
    }
    const presignData = (await presignRes.json()) as { url?: string; uploadUrl?: string };
    const targetUrl = presignData.url ?? presignData.uploadUrl;
    if (!targetUrl) {
      throw new Error(`Missing upload URL for multipart part ${partNumber}`);
    }
    return targetUrl;
  }

  /** Direct multipart upload via presigned / direct upload URLs. */
  async uploadMultipart(
    file: Blob,
    options: { filename?: string; mimeType?: string; partSize?: number } = {},
  ): Promise<{ storageKey: string; uploadId: string }> {
    const filename = options.filename ?? (file instanceof File ? file.name : 'upload.bin');
    const mimeType = options.mimeType ?? (file.type || undefined);
    const initRes = await this.fetchImpl(new URL('/api/v1/uploads/direct', this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename,
        ...(mimeType ? { mimeType } : {}),
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
      key?: string;
      storageKey?: string;
      partSize: number;
      totalParts?: number;
      parts?: Array<{ partNumber: number; uploadUrl?: string; url?: string }>;
      partUrls?: Array<{ partNumber: number; url?: string; uploadUrl?: string }>;
    };

    const partList = initData.parts ?? initData.partUrls ?? [];
    const pregeneratedUrls = new Map<number, string | undefined>();
    for (const partInfo of partList) {
      pregeneratedUrls.set(partInfo.partNumber, partInfo.uploadUrl ?? partInfo.url);
    }
    const totalParts =
      typeof initData.totalParts === 'number' && Number.isInteger(initData.totalParts) && initData.totalParts > partList.length
        ? initData.totalParts
        : partList.length;
    const partNumbers =
      totalParts > partList.length
        ? Array.from({ length: totalParts }, (_, idx) => idx + 1)
        : partList.map((partInfo) => partInfo.partNumber);

    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (const partNumber of partNumbers) {
      let targetUrl: string | undefined;
      if (pregeneratedUrls.has(partNumber)) {
        targetUrl = pregeneratedUrls.get(partNumber);
        if (!targetUrl) {
          throw new Error(`Missing upload URL for multipart part ${partNumber}`);
        }
      } else {
        targetUrl = await this.presignMultipartPart(initData.uploadId, initData.key, partNumber);
      }
      const start = (partNumber - 1) * initData.partSize;
      const end = Math.min(start + initData.partSize, file.size);
      const chunk = file.slice(start, end);
      const putRes = await this.fetchImpl(new URL(targetUrl, this.baseUrl), {
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
      const etag = putRes.headers.get('ETag') || `"${partNumber}"`;
      parts.push({ partNumber, etag });
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
    const completeData = (await completeRes.json()) as { storageKey?: string; key?: string };
    return {
      storageKey: completeData.storageKey ?? completeData.key ?? initData.key ?? initData.storageKey ?? '',
      uploadId: initData.uploadId,
    };
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
      res = await this.fetchImpl(new URL('/api/v1/archives/inspect', this.baseUrl), {
        method: 'POST',
        headers: { Authorization: this.authorization },
        body: formData,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } else if (params.storageKey) {
      res = await this.fetchImpl(new URL('/api/v1/archives/inspect', this.baseUrl), {
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
    providerType: 's3' | 'r2' | 'gcs' | 'azure-blob' | 'webdav' | 'sftp';
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

  /**
   * Verifies incoming HMAC-SHA256 webhook signature.
   * Supports Standard Webhooks (`v1,<base64>` space-separated signatures with `{deliveryId}.{timestamp}.{payload}`)
   * and legacy (`sha256=<hex>` or `<hex>` over `{timestamp}.{payload}`).
   */
  static async verifyWebhookSignature(
    payload: string,
    signature: string,
    timestamp: number,
    secret: string,
    toleranceOrOptions: number | VerifyWebhookOptions = 300,
    maybeDeliveryId?: string,
  ): Promise<boolean> {
    const opts = typeof toleranceOrOptions === 'object' ? toleranceOrOptions : undefined;
    const toleranceSeconds = opts?.toleranceSeconds ?? (typeof toleranceOrOptions === 'number' ? toleranceOrOptions : 300);
    const deliveryId = opts?.deliveryId ?? opts?.webhookId ?? maybeDeliveryId;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      return false;
    }

    const trimmedSig = signature.trim();
    const tokens = trimmedSig.split(/\s+/).filter(Boolean);
    const isStandardMode = deliveryId !== undefined || tokens.some((tok) => tok.startsWith('v1,'));

    if (isStandardMode) {
      if (!deliveryId) return false;
      const digest = await computeHmacSha256(secret, `${deliveryId}.${timestamp}.${payload}`);
      if (!digest) return false;
      const expectedToken = `v1,${bytesToBase64(digest)}`;
      let matched = false;
      for (const token of tokens) {
        if (constantTimeEqual(token, expectedToken)) {
          matched = true;
        }
      }
      return matched;
    }

    const cleanSig = trimmedSig.replace(/^sha256=/, '').trim();
    const digest = await computeHmacSha256(secret, `${timestamp}.${payload}`);
    if (!digest) return false;
    const expectedHex = Array.from(digest)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return constantTimeEqual(cleanSig, expectedHex);
  }
}

function extractTusStorageKey(headers: Headers): string | undefined {
  return headers.get('EasyConvert-Storage-Key') || headers.get('X-Storage-Key') || headers.get('Storage-Key') || undefined;
}

function encodeUtf8Base64(input: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf-8').toString('base64');
  }
  return bytesToBase64(new TextEncoder().encode(input));
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function computeHmacSha256(secret: string, message: string): Promise<Uint8Array | null> {
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
    return new Uint8Array(sigBuffer);
  }
  try {
    const cryptoMod = await import('node:crypto');
    return new Uint8Array(cryptoMod.createHmac('sha256', secret).update(message).digest());
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
