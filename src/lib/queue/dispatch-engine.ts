import { dispatchConversion } from '../conversions/dispatch';
import type { ConversionEnginePort, EngineResult } from './engine-port';

/**
 * Conversion engine adapter backed by the shared dispatcher: native engines when the pair has a
 * native route and the engine is installed, otherwise the in-process engine. Used by the queue
 * workers and as the graph executor's default engine.
 */
export const dispatchEngine: ConversionEnginePort = {
  name: 'dispatch-engine',
  async convert(input, sourceFormat, targetFormat, options, originalFilename): Promise<EngineResult> {
    const res = await dispatchConversion(input, sourceFormat, targetFormat, options, originalFilename);
    return {
      buffer: res.buffer,
      size: res.size,
      mimeType: res.mimeType,
      filename: res.filename,
      engineUsed: res.engineUsed,
      executionTimeMs: res.executionTimeMs,
      filePath: res.filePath,
      metadata: res.metadata,
      fallbackReason: res.fallbackReason,
      fallbackChain: res.fallbackChain,
      skippedLinks: res.skippedLinks,
      ocrExtractedText: res.ocrExtractedText,
    };
  },
};
