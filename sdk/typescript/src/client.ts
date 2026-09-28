import type {
  EasyConvertClientConfig,
  ConvertRequestParams,
  ConversionResponse,
  CreateJobParams,
  JobCreatedResult,
  JobDetails,
  JobSummary,
  ApiKey,
  ApiKeyCreateResult,
  ApiKeyScope,
  WebhookDlqEntry,
  DlqReplayResult,
} from './types';

export class EasyConvertClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: EasyConvertClientConfig) {
    if (!config.apiKey || typeof config.apiKey !== 'string') {
      throw new Error('EasyConvertClient requires a valid Bearer API key starting with ec_live_');
    }
    this.apiKey = config.apiKey.trim();
    this.baseUrl = (config.baseUrl || 'https://easyconvert.app').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs || 30000;
  }

  private async request<T = unknown>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${this.apiKey}`);
    headers.set('User-Agent', 'EasyConvert-Node-SDK/1.0.0');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const message = errorBody.error || errorBody.title || errorBody.detail || `HTTP ${response.status}`;
        throw new Error(`EasyConvert API Error (${response.status}): ${message}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Synchronously convert an input file buffer, blob, or string.
   */
  public async convert(params: ConvertRequestParams): Promise<ConversionResponse | ArrayBuffer> {
    const formData = new FormData();

    if (typeof params.file === 'string') {
      formData.append('file', new Blob([params.file]), params.filename || 'document.txt');
    } else if (params.file instanceof Uint8Array || Buffer.isBuffer(params.file)) {
      formData.append('file', new Blob([params.file as unknown as BlobPart]), params.filename || 'input.bin');
    } else {
      formData.append('file', params.file, params.filename || 'input.bin');
    }

    formData.append('targetFormat', params.targetFormat);
    if (params.sourceFormat) formData.append('sourceFormat', params.sourceFormat);
    if (params.options) formData.append('options', JSON.stringify(params.options));

    const headers: Record<string, string> = {};
    if (params.raw) {
      headers['Accept'] = 'application/octet-stream';
    }

    const url = `${this.baseUrl}/api/v1/convert${params.raw ? '?raw=true' : ''}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...headers,
      },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Conversion Error (${response.status}): ${err.error || err.detail || 'Failed'}`);
    }

    if (params.raw) {
      return response.arrayBuffer();
    }
    return (await response.json()) as ConversionResponse;
  }

  /**
   * Submit an asynchronous conversion job to the distributed queue.
   */
  public async createJob(params: CreateJobParams): Promise<JobCreatedResult> {
    if (params.file) {
      const formData = new FormData();
      if (typeof params.file === 'string') {
        formData.append('file', new Blob([params.file]), params.filename || 'upload.bin');
      } else if (params.file instanceof Uint8Array || Buffer.isBuffer(params.file)) {
        formData.append('file', new Blob([params.file as unknown as BlobPart]), params.filename || 'upload.bin');
      } else {
        formData.append('file', params.file, params.filename || 'upload.bin');
      }
      formData.append('targetFormat', params.targetFormat);
      if (params.sourceFormat) formData.append('sourceFormat', params.sourceFormat);
      if (params.options) formData.append('options', JSON.stringify(params.options));
      if (params.webhookUrl) formData.append('webhookUrl', params.webhookUrl);
      if (params.webhookSecret) formData.append('webhookSecret', params.webhookSecret);

      return this.request<JobCreatedResult>('/api/v1/jobs', {
        method: 'POST',
        body: formData,
      });
    }

    return this.request<JobCreatedResult>('/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }

  /**
   * Poll status and progress of a specific asynchronous conversion job.
   */
  public async getJob(jobId: string): Promise<JobDetails> {
    return this.request<JobDetails>(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  /**
   * List conversion jobs for the authenticated developer.
   */
  public async listJobs(options: { status?: string; limit?: number } = {}): Promise<{ total: number; jobs: JobSummary[] }> {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.limit) params.set('limit', options.limit.toString());
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<{ total: number; jobs: JobSummary[] }>(`/api/v1/jobs${query}`);
  }

  /**
   * List all API keys for developer account.
   */
  public async listApiKeys(): Promise<ApiKey[]> {
    const res = await this.request<{ success: boolean; keys: ApiKey[] }>('/api/keys');
    return res.keys;
  }

  /**
   * Generate a new scoped API key.
   */
  public async createApiKey(
    name: string,
    options: {
      scopes?: ApiKeyScope[];
      expiresAt?: number;
      allowedIps?: string[];
      webhookUrl?: string;
      webhookSecret?: string;
    } = {}
  ): Promise<ApiKeyCreateResult> {
    return this.request<ApiKeyCreateResult>('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ...options }),
    });
  }

  /**
   * Revoke an active API key.
   */
  public async revokeApiKey(keyId: string): Promise<boolean> {
    const res = await this.request<{ success: boolean }>(`/api/keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE',
    });
    return res.success;
  }

  /**
   * List all dead-lettered webhooks.
   */
  public async getDlqEntries(): Promise<WebhookDlqEntry[]> {
    const res = await this.request<{ success: boolean; entries: WebhookDlqEntry[] }>('/api/webhooks/dlq');
    return res.entries;
  }

  /**
   * Inspect a specific dead-lettered webhook.
   */
  public async getDlqEntry(id: string): Promise<WebhookDlqEntry> {
    const res = await this.request<{ success: boolean; entry: WebhookDlqEntry }>(`/api/webhooks/dlq/${encodeURIComponent(id)}`);
    return res.entry;
  }

  /**
   * Delete a dead-lettered webhook.
   */
  public async deleteDlqEntry(id: string): Promise<boolean> {
    const res = await this.request<{ success: boolean }>(`/api/webhooks/dlq/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return res.success;
  }

  /**
   * Clear the entire webhook dead letter queue.
   */
  public async clearDlq(): Promise<boolean> {
    const res = await this.request<{ success: boolean }>('/api/webhooks/dlq', {
      method: 'DELETE',
    });
    return res.success;
  }

  /**
   * Manually replay a dead-lettered webhook.
   */
  public async replayDlq(id: string): Promise<DlqReplayResult> {
    return this.request<DlqReplayResult>(`/api/webhooks/dlq/${encodeURIComponent(id)}/replay`, {
      method: 'POST',
    });
  }
}
