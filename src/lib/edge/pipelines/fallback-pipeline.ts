/**
 * Serverless Fail-Closed Bridge & Fallback Pipeline (Level 4 - L4)
 *
 * Enforces the core privacy and security invariants:
 * 1. Fail-Closed Principle: If clientEdgeMode === true is set by user, conversions
 *    that cannot be executed in the local browser edge MUST NOT silently upload to cloud.
 * 2. Explicit Consent Routing: Only route to Cloud Serverless API (/api/convert)
 *    when user has not strictly enforced client-only execution.
 */

import { ConversionFailedError, ConversionOptions, ConversionQueueItem } from '../../types';
import { serverRefusal } from '../../conversion-failure';
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
 * Executes serverless cloud conversion; the server keeps the result until the retention rule of entry 125 deletes it.
 */
export async function executeServerlessCloudFallback(
  file: File | Blob,
  targetFormat: string,
  options: ConversionOptions = {},
  signal?: AbortSignal
): Promise<CloudConversionResult> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('targetFormat', targetFormat);
  formData.append('options', JSON.stringify(options));

  const res = await fetch('/api/convert', {
    method: 'POST',
    body: formData,
    signal,
  });

  if (!res.ok) {
    throw serverRefusal(await res.json().catch(() => ({})), res.status, 'Serverless cloud conversion failed.');
  }

  const blob = await res.blob();
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new ConversionFailedError('This runtime cannot create a download URL for the converted file.');
  }
  const url = URL.createObjectURL(blob);

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
