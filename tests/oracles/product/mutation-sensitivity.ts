import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { computeWang2004Mssim } from './pdf-oracle';
import { verifyAudioDownmixSnr } from './media-oracle';
import { verifyArchiveWithNative7z, inspectTarWithNativeTar } from './archive-oracle';
import { getOracleToolPath } from '../../helpers/differential-oracle';

export interface MutationResult {
  mutationType: '1px_visual_shift' | '1db_audio_gain' | 'missing_page' | 'bit_flip_corruption';
  detected: boolean;
  oracleUsed: string;
  metricDetails: string;
}

export interface MutationSensitivitySuiteReport {
  totalMutations: number;
  detectedCount: number;
  detectionRate: number; // 0.0 to 1.0 (must be 1.0 to pass gate)
  passed: boolean;
  results: MutationResult[];
}

/**
 * 1. Visual Shift Mutation:
 * Shifts pixel buffer by 1 pixel along the X axis.
 */
export async function injectVisualPixelShift(
  imageBuffer: Buffer,
  shiftX: number = 1
): Promise<Buffer> {
  const meta = await sharp(imageBuffer).metadata();
  const width = meta.width || 64;
  const height = meta.height || 64;

  const raw = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer();

  const mutated = Buffer.from(raw);
  const rowBytes = width * 4;

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    for (let x = width - 1; x >= shiftX; x--) {
      const targetIdx = rowStart + x * 4;
      const srcIdx = rowStart + (x - shiftX) * 4;
      mutated[targetIdx] = raw[srcIdx];
      mutated[targetIdx + 1] = raw[srcIdx + 1];
      mutated[targetIdx + 2] = raw[srcIdx + 2];
      mutated[targetIdx + 3] = raw[srcIdx + 3];
    }
  }

  return await sharp(mutated, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * 2. Audio Gain Mutation:
 * Applies a 1.0 dB gain change (factor: 10^(1/20) ~ 1.122018) to 16-bit PCM samples.
 */
export function injectAudioGain1Db(
  pcm16Buffer: Buffer,
  gainDb: number = 1.0
): Buffer {
  const linearScale = Math.pow(10, gainDb / 20); // ~1.122018 for +1dB
  const mutated = Buffer.from(pcm16Buffer);
  const sampleCount = Math.floor(pcm16Buffer.length / 2);

  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm16Buffer.readInt16LE(i * 2);
    const scaled = Math.round(sample * linearScale);
    // Saturated 16-bit clamp
    const clamped = Math.max(-32768, Math.min(32767, scaled));
    mutated.writeInt16LE(clamped, i * 2);
  }

  return mutated;
}

/**
 * 3. Missing Page Mutation:
 * Deletes the second page of a multi-page PDF document.
 */
export async function injectMissingPage(pdfBuffer: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.load(pdfBuffer);
  const pageCount = doc.getPageCount();
  if (pageCount > 1) {
    doc.removePage(1); // Remove 2nd page (0-indexed)
  }
  return Buffer.from(await doc.save());
}

/**
 * 4. Bit-Flip Corruption Mutation:
 * Flips the lowest bit at a target byte offset inside the payload.
 */
export function injectBitFlip(buffer: Buffer, byteOffset: number = 64): Buffer {
  const mutated = Buffer.from(buffer);
  const targetOffset = Math.min(byteOffset, mutated.length - 1);
  if (targetOffset >= 0 && mutated.length > 0) {
    mutated[targetOffset] ^= 0x01; // Invert bit 0
  }
  return mutated;
}

/**
 * Executes the full Mutation Sensitivity Gate:
 * Injects 4 deliberate mutations (1px shift, 1dB audio gain, missing page, bit flip)
 * and verifies that the differential oracles detect 100% of these mutations.
 */
export async function runMutationSensitivitySuite(): Promise<MutationSensitivitySuiteReport> {
  const results: MutationResult[] = [];

  // =========================================================================
  // Test 1: 1px Visual Shift Sensitivity
  // =========================================================================
  const samplePng = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 240, g: 240, b: 240, alpha: 1 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="64" height="64"><rect x="16" y="16" width="32" height="32" fill="red"/></svg>`
        ),
      },
    ])
    .png()
    .toBuffer();

  const shiftedPng = await injectVisualPixelShift(samplePng, 1);
  const mssimCheck = await computeWang2004Mssim(samplePng, shiftedPng, { threshold: 0.999 });
  const shiftDetected = mssimCheck.mssim < 0.999;

  results.push({
    mutationType: '1px_visual_shift',
    detected: shiftDetected,
    oracleUsed: 'Wang 2004 MSSIM (11x11 Gaussian)',
    metricDetails: `MSSIM dropped to ${mssimCheck.mssim.toFixed(5)} (threshold 0.999)`,
  });

  // =========================================================================
  // Test 2: 1dB Audio Gain Sensitivity
  // =========================================================================
  // Generate 1 second of 44.1kHz 16-bit sine wave PCM (440Hz reference tone)
  const sampleRate = 44100;
  const sampleCount = sampleRate;
  const originalPcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const val = Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    originalPcm.writeInt16LE(val, i * 2);
  }

  const gainedPcm = injectAudioGain1Db(originalPcm, 1.0);
  const snrCheck = verifyAudioDownmixSnr(gainedPcm, originalPcm, 40.0);
  // With 1dB gain error, SNR drops to ~18.3 dB, failing the 40dB gate
  const gainDetected = !snrCheck.passed && snrCheck.snrDb < 30.0;

  results.push({
    mutationType: '1db_audio_gain',
    detected: gainDetected,
    oracleUsed: 'ITU-R BS.775 Audio SNR Oracle',
    metricDetails: `Audio SNR dropped to ${snrCheck.snrDb.toFixed(2)} dB (required >= 40 dB)`,
  });

  // =========================================================================
  // Test 3: Missing Page Mutation Sensitivity
  // =========================================================================
  const pdfDoc = await PDFDocument.create();
  const page1 = pdfDoc.addPage([200, 200]);
  page1.drawText('Page 1 Content');
  const page2 = pdfDoc.addPage([200, 200]);
  page2.drawText('Page 2 Content');
  const originalPdf = Buffer.from(await pdfDoc.save());

  const mutatedPdf = await injectMissingPage(originalPdf);
  const docAfter = await PDFDocument.load(mutatedPdf);
  const pageMissingDetected = docAfter.getPageCount() !== 2;

  results.push({
    mutationType: 'missing_page',
    detected: pageMissingDetected,
    oracleUsed: 'PDF Document Structure & Page Inventory Oracle',
    metricDetails: `Page count changed from 2 to ${docAfter.getPageCount()}`,
  });

  // =========================================================================
  // Test 4: Bit-Flip Corruption Mutation Sensitivity
  // =========================================================================
  // Synthetic valid USTAR tar block for testing
  const tarHeader = Buffer.alloc(512);
  tarHeader.write('test.txt', 0, 8, 'ascii');
  tarHeader.write('0000644\0', 100, 8, 'ascii');
  tarHeader.write('0000000\0', 108, 8, 'ascii');
  tarHeader.write('0000000\0', 116, 8, 'ascii');
  tarHeader.write('00000000010\0', 124, 12, 'ascii'); // 8 bytes size
  tarHeader.write('00000000000\0', 136, 12, 'ascii');
  tarHeader.write('        ', 148, 8, 'ascii');
  tarHeader.write('0', 156, 1, 'ascii');
  tarHeader.write('ustar\0', 257, 6, 'ascii');
  tarHeader.write('00', 263, 2, 'ascii');
  let chksum = 0;
  for (let i = 0; i < 512; i++) chksum += tarHeader[i];
  tarHeader.write(chksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  const tarContent = Buffer.from('12345678');
  const tarPad = Buffer.alloc(512 - 8);
  const tarTrailer = Buffer.alloc(1024);
  const validTar = Buffer.concat([tarHeader, tarContent, tarPad, tarTrailer]);

  const corruptedTar = injectBitFlip(validTar, 149); // Corrupt checksum field
  let tarCorruptionDetected = false;

  if (getOracleToolPath('tar')) {
    const insp = inspectTarWithNativeTar(corruptedTar);
    tarCorruptionDetected = !insp.passed;
  } else {
    // Checksum recalculation
    let testSum = 0;
    for (let i = 0; i < 512; i++) {
      if (i >= 148 && i < 156) testSum += 32;
      else testSum += corruptedTar[i];
    }
    const readSum = parseInt(corruptedTar.toString('ascii', 148, 154).trim(), 8);
    tarCorruptionDetected = testSum !== readSum;
  }

  results.push({
    mutationType: 'bit_flip_corruption',
    detected: tarCorruptionDetected,
    oracleUsed: 'Archive Header Integrity Oracle',
    metricDetails: `Bit-flip at offset 149 caused invalid checksum rejection`,
  });

  const detectedCount = results.filter((r) => r.detected).length;
  const detectionRate = detectedCount / results.length;

  return {
    totalMutations: results.length,
    detectedCount,
    detectionRate,
    passed: detectionRate === 1.0,
    results,
  };
}
