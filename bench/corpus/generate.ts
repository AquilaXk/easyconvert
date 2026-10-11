/**
 * Regenerates the committed benchmark corpus deterministically from standard tools: ImageMagick `convert`,
 * ffmpeg and jszip. Every pixel, sample and byte is a pure function of the constants below, so a re-run yields
 * files with the checksums listed in manifest.json. Run with `npx tsx bench/corpus/generate.ts`.
 *
 * The tabular data, the ebooks and the fonts are separate steps (`--only table,book,assets`, comma separated): `table` and
 * `book` need only node; `assets` runs generate-assets.py, which needs pyarrow, openpyxl, fontTools and calibre and writes
 * the Parquet, XLSX, font and MOBI files (those formats have no deterministic writer here, so the committed bytes are
 * the record and manifest.json pins them). A run without `--only` makes everything.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { makeBook, makeTable } from './generate-text';

const CORPUS_DIR = __dirname;
const TOOL_TIMEOUT_MS = 120_000;
const FIXED_ZIP_DATE = new Date(Date.UTC(2020, 0, 1));
const RECORD_COUNT = 5_000;
const PRNG_SEED = 0x2c1b3c6d;
const MAX_CORPUS_BYTES = 5 * 1024 * 1024;

const SCAN_TEXT = [
  'Notes on the harbour survey of the northern shore.',
  'The survey began at dawn, when the tide was low and the air was still.',
  'Each crew member carried a measuring rod, a notebook and a flask of tea.',
  'By noon the team had mapped eleven jetties, four slipways and a ruined mill.',
  'Wind from the west brought rain, so the final sketches were finished indoors.',
  'The harbour master offered the logbooks of the last forty years for study.',
  'Depth soundings were compared against the older charts of the district.',
  'Several channels had silted up, while one new sandbar had appeared.',
  'These findings will be sent to the county office by the end of the month.',
].join('\n');

const DOCX_PARAGRAPHS = [
  'Quarterly Maintenance Report',
  'This report summarises the maintenance work carried out on the pumping stations during the third quarter.',
  'All stations were inspected twice, and every valve was tested under full load.',
  'Completed work',
  'Replaced the worn bearings in the east station pump.',
  'Repainted the control cabinets at the north and south stations.',
  'Calibrated the level sensors and recorded the new offsets.',
  'Station readings',
  'Station | Flow rate | Pressure',
  'East | 420 litres per second | 6.1 bar',
  'North | 380 litres per second | 5.8 bar',
  'South | 405 litres per second | 6.0 bar',
  'The next inspection is planned for the first week of January.',
];

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(bin: string, args: string[]): void {
  execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: TOOL_TIMEOUT_MS });
}

function out(name: string): string {
  return path.join(CORPUS_DIR, name);
}

function makePhotos(): void {
  const plasma = ['-seed', '7', '-size', '768x512', 'plasma:fractal', '-blur', '0x1.2'];
  run('convert', [...plasma, '-attenuate', '0.15', '+noise', 'Gaussian', '-depth', '8', '-strip', '-quality', '92', out('photo-a.jpg')]);
  run('convert', [
    '-seed', '21', '-size', '640x432', 'plasma:fractal', '-blur', '0x0.8',
    '(', '-size', '640x432', 'xc:none', '-fill', 'rgba(250,240,210,0.85)', '-draw', 'ellipse 320,216 150,90 0,360', '-blur', '0x2', ')',
    '-composite', '-attenuate', '0.1', '+noise', 'Gaussian', '-depth', '8', '-strip', out('photo-b.png'),
  ]);
}

function makeScreenshot(): void {
  const font = 'DejaVu-Sans';
  run('convert', [
    '-size', '1024x640', 'xc:#f4f6f8', '-fill', '#1f2a44', '-draw', 'rectangle 0,0 1023,56',
    '-font', font, '-pointsize', '22', '-fill', 'white', '-annotate', '+24+38', 'Conversion queue',
    '-fill', 'white', '-stroke', '#c8d0dc', '-draw', 'roundrectangle 24,84 1000,200 8,8',
    '-stroke', 'none', '-fill', '#1f2a44', '-pointsize', '18', '-annotate', '+44+122', 'holiday-photos.zip',
    '-fill', '#5b6678', '-pointsize', '14', '-annotate', '+44+150', '48 files, 212 MB, waiting for a worker',
    '-fill', '#d9e0ea', '-draw', 'roundrectangle 44,168 700,180 6,6',
    '-fill', '#2f7de1', '-draw', 'roundrectangle 44,168 430,180 6,6',
    '-fill', 'white', '-stroke', '#c8d0dc', '-draw', 'roundrectangle 24,224 1000,340 8,8',
    '-stroke', 'none', '-fill', '#1f2a44', '-pointsize', '18', '-annotate', '+44+262', 'interview-recording.wav',
    '-fill', '#5b6678', '-pointsize', '14', '-annotate', '+44+290', 'Converting to opus at 64 kbit/s',
    '-fill', '#d9e0ea', '-draw', 'roundrectangle 44,308 700,320 6,6',
    '-fill', '#2fa35b', '-draw', 'roundrectangle 44,308 640,320 6,6',
    '-fill', '#e5484d', '-draw', 'roundrectangle 820,250 980,290 6,6',
    '-fill', 'white', '-pointsize', '16', '-annotate', '+862+277', 'Cancel',
    '-fill', '#5b6678', '-font', 'DejaVu-Sans-Mono', '-pointsize', '13',
    '-annotate', '+24+400', '12:01:07  job 4f2a started  engine=ffmpeg',
    '-annotate', '+24+424', '12:01:09  job 4f2a progress 41%',
    '-annotate', '+24+448', '12:01:12  job 91c0 queued  position=2',
    '-strip', out('screenshot.png'),
  ]);
}

function makeLineArt(): void {
  const args = ['-size', '640x640', 'xc:white', '-fill', 'none', '-stroke', 'black', '-strokewidth', '3'];
  for (let ring = 1; ring <= 8; ring++) {
    args.push('-draw', `circle 320,320 ${320 + ring * 36},320`);
  }
  for (let spoke = 0; spoke < 16; spoke++) {
    const angle = (spoke * Math.PI) / 8;
    args.push('-strokewidth', '1.5', '-draw', `line 320,320 ${(320 + 300 * Math.cos(angle)).toFixed(2)},${(320 + 300 * Math.sin(angle)).toFixed(2)}`);
  }
  args.push('-strokewidth', '2', '-draw', 'polygon 120,120 520,160 480,520 160,480', '-strip', out('lineart.png'));
  run('convert', args);
}

function makeScan(): void {
  fs.writeFileSync(out('scan.gt.txt'), `${SCAN_TEXT}\n`);
  run('convert', [
    '-size', '860x280', 'xc:white', '-font', 'DejaVu-Serif', '-pointsize', '16', '-fill', 'black',
    '-interline-spacing', '4', '-annotate', '+40+50', SCAN_TEXT,
    '-rotate', '0.6', '-background', 'white', '-gravity', 'center', '-crop', '840x260+0+0', '+repage',
    '-blur', '0x1.0', '-seed', '5', '-attenuate', '0.8', '+noise', 'Gaussian', '-colorspace', 'Gray', '-depth', '8', '-strip',
    out('scan.png'),
  ]);
}

function lineXml(text: string, bold: boolean, halfPoints: number): string {
  const props = `<w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${halfPoints}"/></w:rPr>`;
  return `<w:p><w:r>${props}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function tableXml(rows: string[][]): string {
  const cells = (row: string[]): string =>
    row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${lineXml(cell, false, 22)}</w:tc>`).join('');
  const border = '<w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/>';
  return `<w:tbl><w:tblPr><w:tblBorders>${border}</w:tblBorders></w:tblPr>${rows.map((r) => `<w:tr>${cells(r)}</w:tr>`).join('')}</w:tbl>`;
}

async function makeDocx(): Promise<void> {
  const headings = new Set([DOCX_PARAGRAPHS[0], 'Completed work', 'Station readings']);
  const tableRows = DOCX_PARAGRAPHS.filter((p) => p.includes(' | ')).map((p) => p.split(' | '));
  const body: string[] = [];
  let tableWritten = false;
  for (const paragraph of DOCX_PARAGRAPHS) {
    if (paragraph.includes(' | ')) {
      if (!tableWritten) body.push(tableXml(tableRows));
      tableWritten = true;
    } else if (headings.has(paragraph)) {
      body.push(lineXml(paragraph, true, paragraph === DOCX_PARAGRAPHS[0] ? 40 : 28));
    } else {
      body.push(lineXml(paragraph, false, 22));
    }
  }
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const zip = new JSZip();
  const opts = { date: FIXED_ZIP_DATE, createFolders: false };
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', opts);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', opts);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`, opts);
  fs.writeFileSync(out('report.docx'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
  const gt = DOCX_PARAGRAPHS.map((p) => p.replace(/ \| /g, ' ')).join('\n');
  fs.writeFileSync(out('report.gt.txt'), `${gt}\n`);
}

function makeAudio(): void {
  const speechText = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump.';
  const bitexact = ['-bitexact', '-fflags', '+bitexact', '-map_metadata', '-1'];
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `flite=text='${speechText}':voice=slt`, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', ...bitexact, out('speech.wav')]);
  const chord = (freq: number, decay: number, period: number, offset: number, gain: number): string =>
    `${gain}*sin(2*PI*${freq}*t)*exp(-${decay}*mod(t+${offset},${period}))`;
  const left = [chord(261.63, 3, 0.5, 0, 0.25), chord(329.63, 3, 0.5, 0.25, 0.2), chord(392, 2, 1, 0, 0.15), chord(523.25, 4, 0.25, 0, 0.1)].join('+');
  const right = [chord(196, 2, 1, 0, 0.2), chord(293.66, 3, 0.5, 0.125, 0.2), chord(440, 3, 0.75, 0, 0.1)].join('+');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${left}|${right}':s=44100:d=4`, '-c:a', 'pcm_s16le', ...bitexact, out('music.wav')]);
}

function makeVideo(): void {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'mandelbrot=s=320x240:r=24:end_scale=0.05:start_scale=3',
    '-t', '2', '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-bitexact', '-fflags', '+bitexact',
    '-an', '-map_metadata', '-1', out('clip.mp4'),
  ]);
}

/** Small deterministic generator (mulberry32) so the data file does not depend on Math.random. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRecords(): void {
  const random = prng(PRNG_SEED);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const levels = ['info', 'info', 'info', 'warn', 'error', 'debug'] as const;
  const services = ['gateway', 'queue', 'worker', 'storage', 'auth'] as const;
  const messages = ['request accepted', 'job enqueued', 'upload completed', 'conversion finished', 'retry scheduled', 'token refreshed', 'cache miss', 'cache hit'] as const;
  const lines: string[] = [];
  let timestamp = Date.UTC(2024, 0, 1);
  for (let i = 0; i < RECORD_COUNT; i++) {
    timestamp += Math.floor(random() * 900) + 1;
    const record = {
      ts: new Date(timestamp).toISOString(),
      level: pick(levels),
      service: pick(services),
      msg: pick(messages),
      job: Math.floor(random() * 0xffffff).toString(16).padStart(6, '0'),
      ms: Math.floor(random() * random() * 4000),
      bytes: Math.floor(random() * 1_000_000),
    };
    lines.push(JSON.stringify(record));
  }
  fs.mkdirSync(out('data'), { recursive: true });
  fs.writeFileSync(out('data/records.jsonl'), `${lines.join('\n')}\n`);
}

function writeManifest(): void {
  const entries: Array<{ file: string; bytes: number; sha256: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!/\.(ts|py|md)$|manifest\.json$/.test(entry.name)) {
        entries.push({ file: path.relative(CORPUS_DIR, full), bytes: fs.statSync(full).size, sha256: sha256(full) });
      }
    }
  };
  walk(CORPUS_DIR);
  entries.sort((a, b) => a.file.localeCompare(b.file));
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total > MAX_CORPUS_BYTES) throw new Error(`Corpus is ${total} bytes, over the ${MAX_CORPUS_BYTES} byte budget`);
  fs.writeFileSync(out('manifest.json'), `${JSON.stringify({ totalBytes: total, files: entries }, null, 2)}\n`);
}

/** Python assets: the Parquet, XLSX, font and MOBI files, written by libraries and tools with no deterministic mode. */
function makeAssets(): void {
  execFileSync('python3', ['-I', path.join(CORPUS_DIR, 'generate-assets.py'), CORPUS_DIR], { stdio: ['ignore', 'inherit', 'inherit'], timeout: TOOL_TIMEOUT_MS });
}

const STEPS: Readonly<Record<string, () => void | Promise<void>>> = {
  photos: makePhotos,
  screenshot: makeScreenshot,
  lineart: makeLineArt,
  scan: makeScan,
  docx: makeDocx,
  audio: makeAudio,
  video: makeVideo,
  records: makeRecords,
  table: () => makeTable(CORPUS_DIR),
  book: () => makeBook(CORPUS_DIR),
  assets: makeAssets,
};

async function main(): Promise<void> {
  const only = process.argv.indexOf('--only');
  const names = only >= 0 ? process.argv[only + 1].split(',') : Object.keys(STEPS);
  const unknown = names.filter((name) => STEPS[name] === undefined);
  if (unknown.length > 0) throw new Error(`unknown step ${unknown.join(', ')}; use ${Object.keys(STEPS).join(', ')}`);
  for (const name of names) await STEPS[name]();
  writeManifest();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
