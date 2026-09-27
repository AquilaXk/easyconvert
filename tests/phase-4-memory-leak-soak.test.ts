import { describe, it, expect } from 'vitest';
import fs from 'fs';
import sharp from 'sharp';
import { encodeParquet, decodeParquet } from '../src/lib/conversions/parquet';
import { compressZstd, decompressZstd } from '../src/lib/conversions/zstd';
import {
  inspectVariableFont,
  instantiateVariableFont,
} from '../src/lib/conversions/font';
import {
  parseDrawingMlShapes,
  renderDrawingMlToSvg,
} from '../src/lib/conversions/office';
import { synthesizeVariableFontCorpus } from './helpers/corpus-synthesizer';

/**
 * Returns list of open file descriptors on Unix/macOS or empty list if unavailable.
 */
function getOpenFileDescriptors(): number[] {
  try {
    if (fs.existsSync('/dev/fd')) {
      return fs.readdirSync('/dev/fd').map((f) => parseInt(f, 10)).filter((n) => !isNaN(n));
    }
  } catch {}
  return [];
}

describe('Phase 4: 1,000-Iteration Memory Leak & File Descriptor Soak Test', () => {
  it('profiles 1,000 iterative conversions across documents, archives, and media with heap stabilization and zero FD leaks', async () => {
    // 1. Capture initial resource baselines
    if (typeof global.gc === 'function') {
      global.gc();
    }

    const initialFds = getOpenFileDescriptors();
    const memInitial = process.memoryUsage();

    const fontCorpus = synthesizeVariableFontCorpus();
    const testRecords = [
      { id: 101, name: 'Alice', score: 98.5, active: true },
      { id: 102, name: 'Bob', score: 85.0, active: false },
      { id: 103, name: 'Charlie', score: 92.1, active: true },
    ];
    const rawArchiveData = Buffer.from(
      'EasyConvert enterprise endurance soak testing bitstream data with repeatable sequences.'
    );
    const drawingMlXml = `
      <p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:spPr>
          <a:xfrm><a:off x="10" y="10"/><a:ext cx="100" cy="50"/></a:xfrm>
          <a:prstGeom prst="roundRect"/>
          <a:solidFill><a:srgbClr val="5C6BC0"/></a:solidFill>
        </p:spPr>
      </p:sp>`;

    const totalIterations = 1000;
    const batchSize = 250;

    let heapAtWarmup = 0;
    const startTime = Date.now();

    // 2. Execute 1,000 Iteration Conversion Soak
    for (let i = 0; i < totalIterations; i++) {
      const mode = i % 4;

      if (mode === 0) {
        // Tabular Parquet Columnar Serialization & Deserialization
        const parquetBuf = encodeParquet(testRecords);
        const decoded = decodeParquet(parquetBuf);
        if (decoded.length !== 3) {
          throw new Error('Parquet soak integrity check failed');
        }
      } else if (mode === 1) {
        // Zstandard Streaming Compression & Decompression
        const compressed = compressZstd(rawArchiveData);
        const decompressed = decompressZstd(compressed);
        if (decompressed.length !== rawArchiveData.length) {
          throw new Error('Zstd soak integrity check failed');
        }
      } else if (mode === 2) {
        // Variable Font Inspection & Dynamic SFNT Instantiation
        const meta = inspectVariableFont(fontCorpus.fontBuffer);
        if (!meta.isVariableFont) {
          throw new Error('Font soak integrity check failed');
        }
        instantiateVariableFont(fontCorpus.fontBuffer, { wght: 400 + (i % 500) });
      } else if (mode === 3) {
        // DrawingML Vector Parsing & SVG Rendering
        const shapes = parseDrawingMlShapes(drawingMlXml);
        const { svg } = renderDrawingMlToSvg(shapes);
        if (!svg.includes('<svg')) {
          throw new Error('DrawingML soak integrity check failed');
        }
      }

      // Record heap after warm-up phase (iteration 200) to account for V8 JIT & initial allocations
      if (i === 200) {
        if (typeof global.gc === 'function') global.gc();
        heapAtWarmup = process.memoryUsage().heapUsed;
      }
    }

    const durationMs = Date.now() - startTime;

    // 3. Final Resource Audit post 1,000 iterations
    if (typeof global.gc === 'function') {
      global.gc();
    }
    const memFinal = process.memoryUsage();
    const finalFds = getOpenFileDescriptors();

    // 4. Assertions

    // Execution performance: 1,000 conversions must complete within a reasonable budget (< 15 seconds)
    expect(durationMs).toBeLessThan(15000);

    // File Descriptor Leak Check:
    // Open file descriptors must not leak persistently. Allow +/- 2 margin for transient test runtime handles.
    if (initialFds.length > 0 && finalFds.length > 0) {
      const fdDelta = finalFds.length - initialFds.length;
      expect(fdDelta).toBeLessThanOrEqual(2);
    }

    // Heap Stabilization Check:
    // After warm-up (iteration 200), heap growth to iteration 1000 must remain strictly bounded.
    // Absolute heapUsed growth after warm-up must be < 40MB.
    if (heapAtWarmup > 0) {
      const postWarmupHeapDeltaMb = (memFinal.heapUsed - heapAtWarmup) / (1024 * 1024);
      expect(postWarmupHeapDeltaMb).toBeLessThan(40);
    }
  }, 20000); // 20s timeout budget
});
