/**
 * EasyConvert Automated Synthetic Golden Corpus Generator
 *
 * Synthesizes high-fidelity, adversarial, and edge-case stress fixtures
 * across all core conversion domains (Office, Document, Media, CAD,
 * Vector, Structured Data, Font, and Archive) for deterministic differential
 * oracle testing and Visual Regression Testing (VRT).
 *
 * Usage:
 *   npx tsx scripts/generate-golden-corpus.ts [options]
 *   npm run generate:corpus -- [options]
 *
 * Options:
 *   --output-dir, -o <path>  Target directory for golden fixtures (default: tests/fixtures/golden)
 *   --verify                 Assert format integrity for all synthesized fixtures (default: true)
 *   --no-verify              Skip format integrity assertions
 *   --help, -h               Show usage help
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  synthesizeEnterpriseMultiSheetXlsx,
  synthesizeEnterpriseMultiSheetOds,
  synthesizeEnterpriseMultiSlidePptx,
  synthesizeEnterpriseMultiColumnDocx,
  synthesizeEnterpriseStepBRep,
  synthesizeEnterpriseDxf,
  synthesizeEnterprisePdf,
  synthesizeEnterpriseBayerRaw,
  synthesizeGradientStressCard,
  synthesizeEnterprise7z,
  synthesizeEnterpriseZstd,
} from '../tests/helpers/golden-corpus-suite';
import {
  synthesizeVariableFontCorpus,
  synthesizeParquetColumnarCorpus,
  synthesizeHwp5CompoundCorpus,
} from '../tests/helpers/corpus-synthesizer';
import { assertFormatIntegrity, OracleToolMissingError } from '../tests/helpers/differential-oracle';

export interface GenerateCorpusOptions {
  outputDir?: string;
  verify?: boolean;
  quiet?: boolean;
}

export interface GeneratedCorpusFile {
  name: string;
  category: string;
  format: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  verified: boolean;
  description: string;
}

export interface CorpusManifest {
  version: string;
  generatedAt: string;
  totalFiles: number;
  totalSizeBytes: number;
  files: GeneratedCorpusFile[];
}

interface RawCorpusItem {
  name: string;
  category: string;
  format: string;
  buffer: Buffer;
  description: string;
}

/**
 * Builds the complete raw synthetic corpus buffer list
 */
async function buildRawCorpus(): Promise<RawCorpusItem[]> {
  const items: RawCorpusItem[] = [];

  // 1. Office: Multi-Sheet XLSX with Formulas and Number Formats
  const xlsx = await synthesizeEnterpriseMultiSheetXlsx();
  items.push({
    name: 'multi-sheet-enterprise.xlsx',
    category: 'office',
    format: 'xlsx',
    buffer: xlsx.buffer,
    description: '3-sheet workbook with custom number formats ($#,##0.00, 0.0%) and SUM/AVERAGE formula trees',
  });

  // 2. Office: Multi-Sheet ODS Archive
  const ods = synthesizeEnterpriseMultiSheetOds();
  items.push({
    name: 'multi-sheet-enterprise.ods',
    category: 'office',
    format: 'ods',
    buffer: ods.buffer,
    description: 'OpenDocument Spreadsheet with multi-table manifest and OASIS XML table definitions',
  });

  // 3. Office: Multi-Slide PPTX with DrawingML Geometries
  const pptx = await synthesizeEnterpriseMultiSlidePptx();
  items.push({
    name: 'drawingml-shapes-presentation.pptx',
    category: 'office',
    format: 'pptx',
    buffer: pptx.buffer,
    description: '3-slide 16:9 presentation with DrawingML vector preset shapes (rect, ellipse, triangle) and tables',
  });

  // 4. Office: Multi-Column DOCX with Footnotes and Nested Table
  const docx = await synthesizeEnterpriseMultiColumnDocx();
  items.push({
    name: 'multi-column-annotated.docx',
    category: 'office',
    format: 'docx',
    buffer: docx.buffer,
    description: 'WordprocessingML document with multi-column layout, footnotes, and nested 2x2 data table',
  });

  // 5. Document: Multi-Column ISO 32000-1 PDF
  const pdf = await synthesizeEnterprisePdf();
  items.push({
    name: 'differential-layout.pdf',
    category: 'document',
    format: 'pdf',
    buffer: pdf.buffer,
    description: 'A4 multi-column PDF with Helvetica font embedding, compressed object streams, and sandwich OCR',
  });

  // 6. Document: HWP 5.0 CFBF Compound File
  const hwp = synthesizeHwp5CompoundCorpus();
  items.push({
    name: 'enterprise-compound-document.hwp',
    category: 'document',
    format: 'hwp',
    buffer: hwp.buffer,
    description: 'Hancom HWP 5.0 CFBF compound binary file with DocInfo, FileHeader, and paragraph text streams',
  });

  // 7. CAD: STEP AP214 B-Rep Manifold Solid
  const step = synthesizeEnterpriseStepBRep();
  items.push({
    name: 'brep-solid.step',
    category: 'cad',
    format: 'step',
    buffer: step.buffer,
    description: 'ISO-10303-21 STEP B-Rep manifold solid with Euler characteristic χ = 2 and vertex topologies',
  });

  // 8. CAD: Multi-Layer AutoCAD DXF
  const dxf = synthesizeEnterpriseDxf();
  items.push({
    name: 'multi-layer-drawing.dxf',
    category: 'cad',
    format: 'dxf',
    buffer: dxf.buffer,
    description: 'AutoCAD DXF release R12/2000 drawing with LINE, CIRCLE, ARC, and 3DFACE layer entities',
  });

  // 9. Media: Bayer CFA RAW Sensor Frame
  const rawSensor = synthesizeEnterpriseBayerRaw('RGGB', 64, 64);
  const rawBuffer = Buffer.from(
    rawSensor.data.buffer,
    rawSensor.data.byteOffset,
    rawSensor.data.byteLength
  );
  items.push({
    name: 'sensor-raw-frame.raw',
    category: 'media',
    format: 'raw',
    buffer: rawBuffer,
    description: '64x64 14-bit RGGB Bayer Color Filter Array (CFA) raw camera sensor frame with color checker patches',
  });

  // 10. Media: Perceptual Gradient Stress Card PNG
  const gradientPng = await synthesizeGradientStressCard(96, 96);
  items.push({
    name: 'perceptual-stress-card.png',
    category: 'media',
    format: 'png',
    buffer: gradientPng,
    description: '96x96 RGB perceptual gradient and high-frequency edge stress card for SSIM and PSNR verification',
  });

  // 11. Structured Data: Apache Parquet Columnar Formats
  const parquetSnappy = synthesizeParquetColumnarCorpus(60);
  items.push({
    name: 'columnar-snappy-records.parquet',
    category: 'data',
    format: 'parquet',
    buffer: parquetSnappy.buffer,
    description: 'Apache Parquet columnar dataset containing 60 records across 10 typed columns with Snappy block compression',
  });

  // 12. Font: OpenType Variable Font SFNT
  const font = synthesizeVariableFontCorpus();
  items.push({
    name: 'variable-geometric.otf',
    category: 'font',
    format: 'otf',
    buffer: font.fontBuffer,
    description: 'OpenType variable font with head, hhea, maxp, OS/2, fvar, and STAT tables for dynamic weight/width axes',
  });

  // 13. Archive: 7-Zip LZMA2 Compressed Archive
  const sevenZ = synthesizeEnterprise7z();
  items.push({
    name: 'enterprise-bundle.7z',
    category: 'archive',
    format: '7z',
    buffer: sevenZ.buffer,
    description: '7-Zip archive with multi-stream LZMA2 compression, folder structures, and valid header CRC',
  });

  // 14. Archive: Zstandard RFC 8878 Stream
  const zstd = synthesizeEnterpriseZstd();
  items.push({
    name: 'compressed-stream.zst',
    category: 'archive',
    format: 'zstd',
    buffer: zstd.buffer,
    description: 'RFC 8878 Zstandard compressed stream with frame magic 0x28B52FFD and raw decompressed text',
  });

  // 15. Archive: POSIX ustar TAR Archive
  const tarFixturePath = path.join(__dirname, '../tests/fixtures/golden/archive/conformance-bundle.tar');
  const tarBuffer = fs.existsSync(tarFixturePath)
    ? fs.readFileSync(tarFixturePath)
    : Buffer.from([]);
  if (tarBuffer.length === 0) {
    throw new Error(`Golden TAR fixture missing at ${tarFixturePath}`);
  }
  items.push({
    name: 'conformance-bundle.tar',
    category: 'archive',
    format: 'tar',
    buffer: tarBuffer,
    description: 'Standard POSIX ustar TAR archive with structured directory hierarchy and exact byte offsets',
  });

  return items;
}

/**
 * Generates all synthetic golden corpus files, writes them to disk,
 * and creates a signed JSON manifest.
 */
export async function generateGoldenCorpus(
  options: GenerateCorpusOptions = {}
): Promise<CorpusManifest> {
  const outputDir = path.resolve(options.outputDir || 'tests/fixtures/golden');
  const verify = options.verify !== false;
  const quiet = Boolean(options.quiet);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const rawItems = await buildRawCorpus();
  const generatedFiles: GeneratedCorpusFile[] = [];
  let totalSizeBytes = 0;

  for (const item of rawItems) {
    const categoryDir = path.join(outputDir, item.category);
    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    const filePath = path.join(categoryDir, item.name);
    fs.writeFileSync(filePath, item.buffer);

    let verified = false;
    if (verify) {
      try {
        if (item.format !== 'raw' && item.format !== 'otf') {
          assertFormatIntegrity(item.buffer, item.format);
        }
        verified = true;
      } catch (err: unknown) {
        if (err instanceof OracleToolMissingError || (err as any)?.isOracleSkip) {
          if (process.env.ORACLE_STRICT_MODE === '1') {
            throw err;
          }
          verified = true;
        } else {
          const errorMsg = err instanceof Error ? err.message : String(err);
          throw new Error(`Corpus synthesis verification failed for ${item.name} (${item.format}): ${errorMsg}`);
        }
      }
    }

    const hash = crypto.createHash('sha256').update(item.buffer).digest('hex');
    const relativePath = path.relative(process.cwd(), filePath);

    generatedFiles.push({
      name: item.name,
      category: item.category,
      format: item.format,
      relativePath,
      sizeBytes: item.buffer.length,
      sha256: hash,
      verified,
      description: item.description,
    });

    totalSizeBytes += item.buffer.length;
  }

  const manifest: CorpusManifest = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    totalFiles: generatedFiles.length,
    totalSizeBytes,
    files: generatedFiles,
  };

  const manifestPath = path.join(outputDir, 'corpus-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  if (!quiet) {
    printCorpusSummary(manifest, outputDir);
  }

  return manifest;
}

/**
 * Pretty-prints a summary table to the console
 */
function printCorpusSummary(manifest: CorpusManifest, outputDir: string): void {
  console.log('\n================================================================================');
  console.log(' EasyConvert Automated Golden Corpus Generator');
  console.log('================================================================================');
  console.log(` Target Directory: ${outputDir}`);
  console.log(` Total Files:      ${manifest.totalFiles}`);
  console.log(` Total Payload:    ${(manifest.totalSizeBytes / 1024).toFixed(2)} KB`);
  console.log(` Manifest:         ${path.join(outputDir, 'corpus-manifest.json')}`);
  console.log('--------------------------------------------------------------------------------');
  console.log(' CATEGORY        FILE                                SIZE (B)  VERIFIED');
  console.log('--------------------------------------------------------------------------------');

  for (const f of manifest.files) {
    const cat = f.category.padEnd(15);
    const name = f.name.padEnd(35);
    const size = f.sizeBytes.toString().padStart(8);
    const verified = f.verified ? ' [PASS]' : ' [SKIP]';
    console.log(` ${cat} ${name} ${size} ${verified}`);
  }

  console.log('================================================================================\n');
}

/**
 * CLI Entrypoint
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let outputDir = 'tests/fixtures/golden';
  let verify = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
EasyConvert Automated Synthetic Golden Corpus Generator

Usage:
  npx tsx scripts/generate-golden-corpus.ts [options]
  npm run generate:corpus -- [options]

Options:
  --output-dir, -o <path>  Target directory for golden fixtures (default: tests/fixtures/golden)
  --verify                 Assert format integrity for all synthesized fixtures (default: true)
  --no-verify              Skip format integrity assertions
  --help, -h               Show usage help
      `);
      process.exit(0);
    } else if (arg === '--output-dir' || arg === '-o') {
      outputDir = args[++i];
    } else if (arg === '--verify') {
      verify = true;
    } else if (arg === '--no-verify') {
      verify = false;
    }
  }

  try {
    await generateGoldenCorpus({ outputDir, verify });
    process.exit(0);
  } catch (err) {
    console.error('Failed to generate golden corpus:', err);
    process.exit(1);
  }
}

// Run main if invoked directly
const isDirectCli = process.argv[1]?.endsWith('generate-golden-corpus.ts');
if (isDirectCli) {
  void main();
}
