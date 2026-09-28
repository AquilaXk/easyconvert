import type { StoredObject } from './oci-storage';

/**
 * Global SSOT Object and Session Registry shared across S3, OCI, and unified storage adapters.
 * Guarantees zero split-brain between asynchronous job submission (S3/upload) and
 * background container workers (OCI/worker), preventing "OCI Object not found" runtime errors.
 */
export const globalSharedObjects = new Map<string, StoredObject>();
