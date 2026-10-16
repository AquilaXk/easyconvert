/** The composition of the regression corpus: files and bytes by source and format, by size class, and the producer classes of each format. */
import type { CorpusFile } from '../manifest';
import { producerClass } from './producer';
import { type SizeClass, sizeClassOf } from './stratify';

const SIZE_CLASSES: readonly SizeClass[] = ['small', 'medium', 'large', 'huge'];
const BYTES_PER_MIB = 1024 * 1024;

interface Tally {
  files: number;
  bytes: number;
}

const add = (tally: Tally | undefined, file: CorpusFile): Tally => ({ files: (tally?.files ?? 0) + 1, bytes: (tally?.bytes ?? 0) + file.size });
const mib = (bytes: number): string => (bytes / BYTES_PER_MIB).toFixed(0);

function tallyBy(files: readonly CorpusFile[], keyOf: (file: CorpusFile) => string): [string, Tally][] {
  const tallies = new Map<string, Tally>();
  for (const file of files) tallies.set(keyOf(file), add(tallies.get(keyOf(file)), file));
  return [...tallies.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The corpus as Markdown tables: totals, source and format, size class, and the number of producer classes per format. */
export function renderCorpusStats(files: readonly CorpusFile[]): string {
  const total = files.reduce<Tally>((sum, file) => ({ files: sum.files + 1, bytes: sum.bytes + file.size }), { files: 0, bytes: 0 });
  const bySourceFormat = tallyBy(files, (file) => `${file.source} | ${file.format}`).map(([key, tally]) => `| ${key} | ${tally.files} | ${mib(tally.bytes)} |`);
  const bySize = SIZE_CLASSES.map((cls) => {
    const tally = tallyBy(files.filter((file) => sizeClassOf(file.size) === cls), () => cls)[0]?.[1] ?? { files: 0, bytes: 0 };
    return `| ${cls} | ${tally.files} | ${mib(tally.bytes)} |`;
  });
  const formats = [...new Set(files.map((file) => file.format))].sort((a, b) => (a < b ? -1 : 1));
  const producers = formats.map((format) => {
    const classes = new Set(files.filter((file) => file.format === format).map((file) => producerClass(file.producer ?? null)));
    return `| ${format} | ${classes.size} |`;
  });
  return [
    `Files: ${total.files}, ${mib(total.bytes)} MiB.`,
    '',
    '| Source | Format | Files | MiB |',
    '|---|---|---|---|',
    ...bySourceFormat,
    '',
    '| Size class | Files | MiB |',
    '|---|---|---|',
    ...bySize,
    '',
    '| Format | Producer classes |',
    '|---|---|',
    ...producers,
    '',
  ].join('\n');
}
