export type ApiKeyScope = 'convert:read' | 'convert:write' | 'storage:download' | '*';

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
  /** Answer a finished synchronous conversion with the bytes of the result instead of JSON. */
  raw?: boolean;
  /** Queue the conversion as a job (`Prefer: respond-async`): the answer is a ConversionAcceptedResponse. */
  respondAsync?: boolean;
  /** Where the event of a queued conversion is sent; needs webhookSecret. */
  webhookUrl?: string;
  webhookSecret?: string;
}

/** The 202 of a conversion that was queued (a file over the synchronous limit, or respondAsync): poll statusUrl for the result. */
export interface ConversionAcceptedResponse {
  success: boolean;
  status: 'accepted';
  jobId: string;
  statusUrl: string;
  sourceFormat?: string;
  targetFormat?: string;
  originalFilename?: string;
  fileSize?: number;
  createdAt?: number;
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
