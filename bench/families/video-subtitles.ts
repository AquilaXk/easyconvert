import fs from 'node:fs';
import path from 'node:path';
import type { FamilyRunner } from '../context';
import { convertWithProject } from '../convert';
import type { BenchRow } from '../report';
import { measuredRow, skippedGroup, SPEC } from '../rows';
import { compareCues, readSubtitle, toleranceFor, type SubtitleKind } from '../subtitle-reader';

/**
 * Subtitle rows of the video family: the eleven subtitle pairs (SubRip, WebVTT, ASS, SSA and MicroDVD read, SubRip, WebVTT and
 * ASS written) on a scene authored for the purpose (tests/fixtures/subtitle: five cues that overlap, carry Korean text, an emoji,
 * markup, positioning, braces and a time past the hour). FFmpeg reads and writes the files, so FFmpeg cannot judge them; the reader
 * of bench/subtitle-reader.ts, written from the format descriptions, reads the source and the output, and the rows count what
 * differs: the number of cues, the cues whose start or end moved by more than a millisecond (a hundredth of a second into ASS,
 * whose times have no finer unit) and the cues whose words changed. No other service or tool converts these files with a fixed
 * contract, so the bar is the source itself: every count is compared with zero. They have no speed row.
 */

const FIXTURE_DIRECTORY = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'subtitle');
const READ_BACK = 'independent subtitle reader (bench/subtitle-reader.ts)';

const PAIRS: readonly (readonly [SubtitleKind, SubtitleKind])[] = [
  ['srt', 'vtt'], ['srt', 'ass'],
  ['vtt', 'srt'], ['vtt', 'ass'],
  ['ass', 'srt'], ['ass', 'vtt'],
  ['ssa', 'srt'], ['ssa', 'vtt'],
  ['sub', 'srt'], ['sub', 'vtt'], ['sub', 'ass'],
];

export const runVideoSubtitles: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const specs = [SPEC.converts, SPEC.cueCountMismatch, SPEC.cueTimingMismatches, SPEC.cueTextMismatches];
  for (const [source, target] of PAIRS) {
    const caseName = `subtitle-authored.${source}->${target}`;
    if (!ctx.inScope('video', caseName) || !ctx.quality) continue;
    const plan = ctx.plan(['ffmpeg'], caseName);
    if (!plan.ok) {
      rows.push(...skippedGroup('video', caseName, specs, READ_BACK, plan));
      continue;
    }
    ctx.log(`video ${caseName}`);
    const input = fs.readFileSync(path.join(FIXTURE_DIRECTORY, `authored.${source}`));
    const converted = await convertWithProject(input, source, target, {}, `authored.${source}`).catch(() => null);
    if (converted === null) {
      rows.push(measuredRow('video', caseName, SPEC.converts, 0, 1, READ_BACK));
      continue;
    }
    const comparison = compareCues(readSubtitle(source, input.toString('utf-8')), readSubtitle(target, converted.buffer.toString('utf-8')), toleranceFor(target));
    rows.push(measuredRow('video', caseName, SPEC.converts, 1, 1, READ_BACK));
    rows.push(measuredRow('video', caseName, SPEC.cueCountMismatch, comparison.countMismatch, 0, READ_BACK));
    rows.push(measuredRow('video', caseName, SPEC.cueTimingMismatches, comparison.timingMismatches, 0, READ_BACK));
    rows.push(measuredRow('video', caseName, SPEC.cueTextMismatches, comparison.textMismatches, 0, READ_BACK));
  }
  return rows;
};
