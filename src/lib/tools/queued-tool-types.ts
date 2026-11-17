export interface QueuedToolJobPayload {
  tool: string;
  options: Record<string, unknown>;
  storedRefs: Array<{ key: string; name: string }>;
  cleanupUploadKeys?: string[];
}
