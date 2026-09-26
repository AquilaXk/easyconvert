/**
 * Serverless Fail-Closed Bridge & Fallback Pipeline (Level 4 - L4)
 *
 * Enforces the core privacy and security invariants:
 * 1. Fail-Closed Principle: If clientEdgeMode === true is set by user, conversions
 *    that cannot be executed in the local browser edge MUST NOT silently upload to cloud.
 * 2. Explicit Consent Routing: Only route to Cloud Serverless API (/api/convert)
 *    when user has not strictly enforced client-only execution.
 * 3. Zero-Data Retention Header Transmission (X-Zero-Retention: true).
 */

import { ConversionOptions, ConversionQueueItem } from '../../types';
import { resolveConversionTier, TierResolution, EdgeCapabilities } from '../tier-router';

/**
 * Custom error thrown when client-edge execution is strictly mandated but unavailable.
 */
export class EdgeConversionRefusalError extends Error {
  public readonly code = 'EDGE_CONVERSION_REFUSED';
  public readonly sourceFormat: string;
  public readonly targetFormat: string;

  constructor(sourceFormat: string, targetFormat: string, reason: string) {
    super(
      `Client Edge policy violation: Format conversion from ${sourceFormat.toUpperCase()} to ${targetFormat.toUpperCase()} is not available in local browser sandbox (${reason}), and clientEdgeMode is strictly enforced without cloud fallback consent.`
    );
    this.name = 'EdgeConversionRefusalError';
    this.sourceFormat = sourceFormat;
    this.targetFormat = targetFormat;
  }
}

/**
 * Validates execution policy and ensures fail-closed protection against silent cloud upload.
 */
export function validateExecutionPolicy(
  sourceFormat: string,
  targetFormat: string,
  fileSize: number,
  options: ConversionOptions = {},
  capabilities?: Partial<EdgeCapabilities>
): TierResolution {
  const resolution = resolveConversionTier(
    sourceFormat,
    targetFormat,
    fileSize,
    options,
    capabilities
  );

  // If user explicitly mandated client-edge only (clientEdgeMode === true), but resolved to cloud L4
  if (options.clientEdgeMode === true && resolution.tier === 'L4') {
    throw new EdgeConversionRefusalError(
      sourceFormat,
      targetFormat,
      resolution.reason
    );
  }

  return resolution;
}

export interface CloudConversionResult {
  blob: Blob;
  url: string;
  size: number;
}

/**
 * Executes serverless cloud conversion with Zero-Data Retention guarantees.
 */
export async function executeServerlessCloudFallback(
  file: File | Blob,
  targetFormat: string,
  options: ConversionOptions = {},
  onProgress?: (progress: number) => void
): Promise<CloudConversionResult> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('targetFormat', targetFormat);
  formData.append('options', JSON.stringify(options));

  onProgress?.(30);

  const res = await fetch('/api/convert', {
    method: 'POST',
    headers: {
      'X-Zero-Retention': 'true',
    },
    body: formData,
  });

  onProgress?.(80);

  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    throw new Error(errJson.error || 'Serverless cloud conversion failed.');
  }

  const blob = await res.blob();
  const url =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(blob)
      : `blob:mock-cloud-url-${Date.now()}`;

  onProgress?.(100);

  return {
    blob,
    url,
    size: blob.size,
  };
}

/**
 * Checks whether an item conversion is permissible under privacy policy.
 */
export function isCloudFallbackPermitted(item: ConversionQueueItem): boolean {
  // If user explicitly required client edge only, cloud fallback is disallowed
  return item.options.clientEdgeMode !== true;
}
