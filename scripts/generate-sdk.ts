import fs from 'node:fs';
import path from 'node:path';

/**
 * Automated Type-Safe SDK Generator for EasyConvert OpenAPI 3.1.0 Specification.
 * Produces isomorphic TypeScript client and PEP 484 compliant Python client.
 */

const ROOT_DIR = path.resolve(__dirname, '..');
const TS_SDK_DIR = path.join(ROOT_DIR, 'sdk', 'typescript');
const PY_SDK_DIR = path.join(ROOT_DIR, 'sdk', 'python');

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ============================================================================
// 1. Generate TypeScript SDK
// ============================================================================
function generateTypeScriptSdk() {
  const srcDir = path.join(TS_SDK_DIR, 'src');
  ensureDir(srcDir);

  // package.json
  const packageJson = {
    name: '@easyconvert/sdk',
    version: '1.0.0',
    description: 'Official type-safe TypeScript/JavaScript client SDK for the EasyConvert platform.',
    main: './dist/index.js',
    module: './dist/index.mjs',
    types: './dist/index.d.ts',
    scripts: {
      build: 'tsc -p tsconfig.json',
      prepublishOnly: 'npm run build',
    },
    keywords: ['easyconvert', 'conversion', 'pdf', 'cad', 'media', 'sdk', 'api'],
    author: 'EasyConvert Engineering',
    license: 'MIT',
  };
  fs.writeFileSync(path.join(TS_SDK_DIR, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf-8');

  // tsconfig.json
  const tsConfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outDir: './dist',
      rootDir: './src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src/**/*'],
  };
  fs.writeFileSync(path.join(TS_SDK_DIR, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2), 'utf-8');

  // src/types.ts
  const typesContent = `export type ApiKeyScope = 'convert:read' | 'convert:write' | 'storage:download' | '*';

export interface EasyConvertClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface ConversionOptions {
  [key: string]: unknown;
}

export interface ConvertRequestParams {
  file: Blob | Buffer | Uint8Array | string;
  filename?: string;
  targetFormat: string;
  sourceFormat?: string;
  options?: ConversionOptions;
  raw?: boolean;
}

export interface ConversionResponse {
  success: boolean;
  fileId: string;
  fileName: string;
  sourceFormat: string;
  targetFormat: string;
  mimeType: string;
  size: number;
  durationMs: number;
  dataUri: string;
  downloadUrl: string;
  expiresAt: number;
}

export interface CreateJobParams {
  file?: Blob | Buffer | Uint8Array;
  filename?: string;
  targetFormat: string;
  sourceFormat?: string;
  options?: ConversionOptions;
  storageKey?: string;
  inputBufferBase64?: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

export interface JobCreatedResult {
  success: boolean;
  jobId: string;
  status: string;
  statusUrl: string;
  createdAt: number;
  sourceFormat?: string;
  targetFormat?: string;
  originalFilename?: string;
}

export interface JobSummary {
  jobId: string;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'cancelled';
  progress?: number;
  sourceFormat?: string;
  targetFormat?: string;
  originalFilename?: string;
  fileSize?: number;
  createdAt: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  result?: unknown;
}

export interface JobDetails extends JobSummary {
  attemptsMade: number;
  logs?: string[];
}

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  status: 'active' | 'revoked';
  allowedIps?: string[];
  webhookUrl?: string;
  scopes?: ApiKeyScope[];
}

export interface ApiKeyCreateResult {
  key: ApiKey;
  secretKey: string;
  warning: string;
}

export interface WebhookDlqEntry {
  id: string;
  originalDeliveryId: string;
  targetUrl: string;
  event: string;
  payload: Record<string, unknown>;
  failedAt: number;
  finalStatusCode?: number;
  errorMessage?: string;
  retryCount: number;
  status: 'failed' | 'replayed';
  replayedAt?: number;
}

export interface QuotaUsage {
  tier: string;
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  resetAt: number;
}

export interface DlqReplayResult {
  success: boolean;
  deliveryId: string;
  url: string;
  event: string;
  statusCode?: number;
  attempts: number;
  durationMs: number;
  message: string;
}
`;
  fs.writeFileSync(path.join(srcDir, 'types.ts'), typesContent, 'utf-8');

  // src/client.ts
  const clientContent = `import type {
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
  QuotaUsage,
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
    const rawUrl = config.baseUrl || 'https://easyconvert.app';
    this.baseUrl = rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl;
    this.timeoutMs = config.timeoutMs || 30000;
  }

  private async request<T = unknown>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    const url = this.baseUrl + normalizedEndpoint;
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', \`Bearer \${this.apiKey}\`);
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
        const message = errorBody.error || errorBody.title || errorBody.detail || \`HTTP \${response.status}\`;
        throw new Error(\`EasyConvert API Error (\${response.status}): \${message}\`);
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

    const url = \`\${this.baseUrl}/api/v1/convert\${params.raw ? '?raw=true' : ''}\`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: \`Bearer \${this.apiKey}\`,
        ...headers,
      },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(\`Conversion Error (\${response.status}): \${err.error || err.detail || 'Failed'}\`);
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
    return this.request<JobDetails>(\`/api/v1/jobs/\${encodeURIComponent(jobId)}\`);
  }

  /**
   * List conversion jobs for the authenticated developer.
   */
  public async listJobs(options: { status?: string; limit?: number } = {}): Promise<{ total: number; jobs: JobSummary[] }> {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.limit) params.set('limit', options.limit.toString());
    const query = params.toString() ? \`?\${params.toString()}\` : '';
    return this.request<{ total: number; jobs: JobSummary[] }>(\`/api/v1/jobs\${query}\`);
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
    const res = await this.request<{ success: boolean }>(\`/api/keys/\${encodeURIComponent(keyId)}\`, {
      method: 'DELETE',
    });
    return res.success;
  }

  /**
   * Get current quota usage and daily conversion limits.
   */
  public async getQuotaUsage(): Promise<QuotaUsage> {
    const res = await this.request<{ success: boolean; usage: QuotaUsage }>('/api/keys/usage');
    return res.usage;
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
    const res = await this.request<{ success: boolean; entry: WebhookDlqEntry }>(\`/api/webhooks/dlq/\${encodeURIComponent(id)}\`);
    return res.entry;
  }

  /**
   * Delete a dead-lettered webhook.
   */
  public async deleteDlqEntry(id: string): Promise<boolean> {
    const res = await this.request<{ success: boolean }>(\`/api/webhooks/dlq/\${encodeURIComponent(id)}\`, {
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
    return this.request<DlqReplayResult>(\`/api/webhooks/dlq/\${encodeURIComponent(id)}/replay\`, {
      method: 'POST',
    });
  }
}
`;
  fs.writeFileSync(path.join(srcDir, 'client.ts'), clientContent, 'utf-8');

  // src/index.ts
  const indexContent = `export * from './types';
export * from './client';
export { EasyConvertClient as default } from './client';
`;
  fs.writeFileSync(path.join(srcDir, 'index.ts'), indexContent, 'utf-8');
}

// ============================================================================
// 2. Generate Python Client SDK
// ============================================================================
function generatePythonSdk() {
  const pkgDir = path.join(PY_SDK_DIR, 'easyconvert');
  ensureDir(pkgDir);

  // pyproject.toml
  const pyProjectToml = `[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "easyconvert"
version = "1.0.0"
description = "Official type-safe Python client SDK for EasyConvert REST API"
readme = "README.md"
requires-python = ">=3.9"
dependencies = [
    "requests>=2.28.0",
]
classifiers = [
    "Programming Language :: Python :: 3",
    "License :: OSI Approved :: MIT License",
    "Operating System :: OS Independent",
]
`;
  fs.writeFileSync(path.join(PY_SDK_DIR, 'pyproject.toml'), pyProjectToml, 'utf-8');
  fs.writeFileSync(path.join(PY_SDK_DIR, 'README.md'), '# EasyConvert Python SDK\nOfficial Python SDK for EasyConvert.\n', 'utf-8');

  // easyconvert/models.py
  const modelsContent = `from typing import Optional, List, Dict, Any, Union
from dataclasses import dataclass

@dataclass
class ConversionResponse:
    success: bool
    file_id: str
    file_name: str
    source_format: str
    target_format: str
    mime_type: str
    size: int
    duration_ms: float
    data_uri: str
    download_url: str
    expires_at: int

@dataclass
class JobSummary:
    job_id: str
    status: str
    created_at: int
    source_format: Optional[str] = None
    target_format: Optional[str] = None
    original_filename: Optional[str] = None
    file_size: Optional[int] = None
    progress: Optional[float] = None
    processed_on: Optional[int] = None
    finished_on: Optional[int] = None
    failed_reason: Optional[str] = None

@dataclass
class ApiKey:
    id: str
    user_id: str
    name: str
    prefix: str
    created_at: int
    status: str
    last_used_at: Optional[int] = None
    expires_at: Optional[int] = None
    allowed_ips: Optional[List[str]] = None
    webhook_url: Optional[str] = None
    scopes: Optional[List[str]] = None

@dataclass
class WebhookDlqEntry:
    id: str
    original_delivery_id: str
    target_url: str
    event: str
    payload: Dict[str, Any]
    failed_at: int
    retry_count: int
    status: str
    final_status_code: Optional[int] = None
    error_message: Optional[str] = None
    replayed_at: Optional[int] = None

@dataclass
class QuotaUsage:
    tier: str
    daily_limit: int
    used_today: int
    remaining: int
    reset_at: int
`;
  fs.writeFileSync(path.join(pkgDir, 'models.py'), modelsContent, 'utf-8');

  // easyconvert/client.py
  const clientPyContent = `import json
import requests
from typing import Optional, Dict, Any, Union, List, BinaryIO
from .models import ConversionResponse, JobSummary, ApiKey, WebhookDlqEntry, QuotaUsage

class EasyConvertClient:
    """Official EasyConvert REST API client."""

    def __init__(self, api_key: str, base_url: str = "https://easyconvert.app", timeout: float = 30.0):
        if not api_key or not isinstance(api_key, str):
            raise ValueError("api_key must be a valid string starting with ec_live_")
        self.api_key = api_key.strip()
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": "EasyConvert-Python-SDK/1.0.0",
        })

    def _request(self, method: str, path: str, **kwargs) -> Dict[str, Any]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        kwargs.setdefault("timeout", self.timeout)
        resp = self.session.request(method, url, **kwargs)
        if not resp.ok:
            try:
                err_data = resp.json()
                msg = err_data.get("error") or err_data.get("detail") or f"HTTP {resp.status_code}"
            except Exception:
                msg = resp.text or f"HTTP {resp.status_code}"
            raise RuntimeError(f"EasyConvert API Error ({resp.status_code}): {msg}")
        return resp.json()

    def convert(
        self,
        file: Union[bytes, BinaryIO],
        target_format: str,
        filename: str = "input.bin",
        source_format: Optional[str] = None,
        options: Optional[Dict[str, Any]] = None,
        raw: bool = False,
    ) -> Union[Dict[str, Any], bytes]:
        """Convert a file synchronously."""
        url = f"{self.base_url}/api/v1/convert{'?raw=true' if raw else ''}"
        files = {"file": (filename, file)}
        data: Dict[str, Any] = {"targetFormat": target_format}
        if source_format:
            data["sourceFormat"] = source_format
        if options:
            data["options"] = json.dumps(options)

        headers = {}
        if raw:
            headers["Accept"] = "application/octet-stream"

        resp = self.session.post(url, files=files, data=data, headers=headers, timeout=self.timeout)
        if not resp.ok:
            raise RuntimeError(f"Conversion failed ({resp.status_code}): {resp.text}")
        if raw:
            return resp.content
        return resp.json()

    def _create_job_multipart(
        self,
        target_format: str,
        file: Union[bytes, BinaryIO],
        filename: Optional[str],
        source_format: Optional[str],
        options: Optional[Dict[str, Any]],
        webhook_url: Optional[str],
        webhook_secret: Optional[str],
    ) -> Dict[str, Any]:
        files = {"file": (filename or "upload.bin", file)}
        data: Dict[str, Any] = {"targetFormat": target_format}
        if source_format:
            data["sourceFormat"] = source_format
        if options:
            data["options"] = json.dumps(options)
        if webhook_url:
            data["webhookUrl"] = webhook_url
        if webhook_secret:
            data["webhookSecret"] = webhook_secret
        url = f"{self.base_url}/api/v1/jobs"
        resp = self.session.post(url, files=files, data=data, timeout=self.timeout)
        if not resp.ok:
            raise RuntimeError(f"Job creation failed ({resp.status_code}): {resp.text}")
        return resp.json()

    def create_job(
        self,
        target_format: str,
        file: Optional[Union[bytes, BinaryIO]] = None,
        filename: Optional[str] = None,
        source_format: Optional[str] = None,
        options: Optional[Dict[str, Any]] = None,
        webhook_url: Optional[str] = None,
        webhook_secret: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Submit an asynchronous conversion job."""
        if file is not None:
            return self._create_job_multipart(
                target_format, file, filename, source_format, options, webhook_url, webhook_secret
            )

        payload: Dict[str, Any] = {"targetFormat": target_format}
        if source_format:
            payload["sourceFormat"] = source_format
        if options:
            payload["options"] = options
        if webhook_url:
            payload["webhookUrl"] = webhook_url
        if webhook_secret:
            payload["webhookSecret"] = webhook_secret
        return self._request("POST", "/api/v1/jobs", json=payload)

    def get_job(self, job_id: str) -> Dict[str, Any]:
        """Get job status and result."""
        return self._request("GET", f"/api/v1/jobs/{job_id}")

    def list_jobs(self, status: Optional[str] = None, limit: int = 50) -> Dict[str, Any]:
        """List conversion jobs."""
        params = {"limit": limit}
        if status:
            params["status"] = status
        return self._request("GET", "/api/v1/jobs", params=params)

    def list_api_keys(self) -> List[Dict[str, Any]]:
        """List API keys."""
        res = self._request("GET", "/api/keys")
        return res.get("keys", [])

    def create_api_key(
        self,
        name: str,
        scopes: Optional[List[str]] = None,
        expires_at: Optional[int] = None,
        allowed_ips: Optional[List[str]] = None,
        webhook_url: Optional[str] = None,
        webhook_secret: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a new API key."""
        payload: Dict[str, Any] = {"name": name}
        if scopes:
            payload["scopes"] = scopes
        if expires_at:
            payload["expiresAt"] = expires_at
        if allowed_ips:
            payload["allowedIps"] = allowed_ips
        if webhook_url:
            payload["webhookUrl"] = webhook_url
        if webhook_secret:
            payload["webhookSecret"] = webhook_secret
        return self._request("POST", "/api/keys", json=payload)

    def revoke_api_key(self, key_id: str) -> bool:
        """Revoke an API key."""
        res = self._request("DELETE", f"/api/keys/{key_id}")
        return res.get("success", False)

    def get_quota_usage(self) -> Dict[str, Any]:
        """Get current quota usage and daily limits."""
        res = self._request("GET", "/api/keys/usage")
        return res.get("usage", {})

    def get_dlq_entries(self) -> List[Dict[str, Any]]:
        """List dead-lettered webhook entries."""
        res = self._request("GET", "/api/webhooks/dlq")
        return res.get("entries", [])

    def get_dlq_entry(self, dlq_id: str) -> Dict[str, Any]:
        """Get dead-lettered webhook entry by ID."""
        res = self._request("GET", f"/api/webhooks/dlq/{dlq_id}")
        return res.get("entry", {})

    def delete_dlq_entry(self, dlq_id: str) -> bool:
        """Delete a dead-lettered webhook entry."""
        res = self._request("DELETE", f"/api/webhooks/dlq/{dlq_id}")
        return res.get("success", False)

    def clear_dlq(self) -> bool:
        """Clear all dead-lettered webhook entries."""
        res = self._request("DELETE", "/api/webhooks/dlq")
        return res.get("success", False)

    def replay_dlq(self, dlq_id: str) -> Dict[str, Any]:
        """Replay a dead-lettered webhook."""
        return self._request("POST", f"/api/webhooks/dlq/{dlq_id}/replay")
`;
  fs.writeFileSync(path.join(pkgDir, 'client.py'), clientPyContent, 'utf-8');

  // easyconvert/__init__.py
  const initPy = `"""EasyConvert Official Python SDK."""
from .client import EasyConvertClient
from .models import ConversionResponse, JobSummary, ApiKey, WebhookDlqEntry, QuotaUsage

__all__ = ["EasyConvertClient", "ConversionResponse", "JobSummary", "ApiKey", "WebhookDlqEntry", "QuotaUsage"]
__version__ = "1.0.0"
`;
  fs.writeFileSync(path.join(pkgDir, '__init__.py'), initPy, 'utf-8');
}

function main() {
  console.log('⚡ Generating TypeScript SDK in sdk/typescript...');
  generateTypeScriptSdk();
  console.log('⚡ Generating Python SDK in sdk/python...');
  generatePythonSdk();
  console.log('✅ SDK generation completed successfully.');
}

main();
