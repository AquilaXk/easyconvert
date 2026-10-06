import type { NextResponse } from 'next/server';
import { UNAVAILABLE_STORAGE_PROVIDERS } from '@/lib/storage/adapters';
import { createProblemDetailsResponse } from './problem-details';

const BYOS_PROVIDER_UNAVAILABLE_TYPE = 'https://api.easyconvert.io/problems/byos-provider-unavailable';
const HTTP_BAD_REQUEST = 400;

/**
 * Refuses registration for a provider without a working client. Returns the problem response,
 * or null when the provider is available. `unavailable` defaults to the production set.
 */
export function refuseUnavailableStorageProvider(
  providerType: string,
  instanceUri: string,
  unavailable: ReadonlySet<string> = UNAVAILABLE_STORAGE_PROVIDERS
): NextResponse | null {
  if (!unavailable.has(providerType)) {
    return null;
  }
  return createProblemDetailsResponse(
    HTTP_BAD_REQUEST,
    `Storage provider "${providerType}" is not available for customer storage yet.`,
    instanceUri,
    'Storage Provider Unavailable',
    BYOS_PROVIDER_UNAVAILABLE_TYPE
  );
}
