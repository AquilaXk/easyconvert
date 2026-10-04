import type { ConversionOptions } from '../types';

export interface VfsPayload {
  inputPath?: string;
  outputPath?: string;
  inputBuffer?: Buffer;
}

export interface EngineResult {
  buffer: Buffer;
  size: number;
  mimeType: string;
  filename: string;
  engineUsed?: string;
  filePath?: string;
  executionTimeMs?: number;
  metadata?: Record<string, unknown>;
  fallbackReason?: string;
  fallbackChain?: string[];
  ocrExtractedText?: string;
}

export interface ConversionEnginePort {
  readonly name: string;
  convert(
    input: Buffer | VfsPayload,
    sourceFormat: string,
    targetFormat: string,
    options: ConversionOptions & { signal?: AbortSignal; ocrEnabled?: boolean },
    originalFilename: string
  ): Promise<EngineResult>;
}
