import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { MAX_SUBTITLE_BYTES, MAX_SUBTITLE_CUES, MAX_SUBTITLE_LINE_BREAKS, MAX_SUBTITLE_LINE_CHARS, MAX_SUBTITLE_LINES, prepareSubtitleInput, repairSubtitleOutput } from '../src/lib/conversions/subtitle';
import { FORMAT_REGISTRY, getFormatByExtension, isFormatCompatibleWithMagicBytes } from '../src/lib/registry';
import { countSubtitleCues, SUBTITLE_FORMATS, type SubtitleFormat } from '../src/lib/subtitle-structure';
import { EngineUnavailableError, FileExtensionSpoofError, InvalidSubtitleInputError, PayloadLimitError } from '../src/lib/types';
import { compareCues, readSubtitle, toleranceFor, type SubtitleKind } from '../bench/subtitle-reader';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';
import { expectNoHang } from './helpers/timing';

/**
 * Subtitle conversions (docs/policy-decisions.md, entry 188). FFmpeg reads and writes the files in the sandbox of the media path;
 * what is judged here is what comes out. Every output is read back by `bench/subtitle-reader.ts`, a reader of the five formats
 * written for the purpose from the format descriptions (it is not FFmpeg, and not the product's structure check), and compared
 * with the source read by the same reader: the number of cues, the start and end of each within a millisecond (within a
 * hundredth of a second for ASS, whose times have no finer unit) and the words of each.
 *
 * Sources: files authored for these tests (tests/fixtures/subtitle, one scene in each format) and real files of the real-world
 * corpus (bench/realworld/manifest.json). The real files that other writers made malformed on purpose, or with times before
 * zero, are judged by the conversion's own checks only: it converts, every cue it keeps is in the source, and nothing is empty.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'subtitle');
const ffmpegMissing = skipWithoutTools('ffmpeg');

/** The pairs offered: SubRip, WebVTT and ASS are written, the SubStation Alpha file and the MicroDVD file are read as well. */
const TARGETS: Readonly<Record<SubtitleFormat, readonly SubtitleFormat[]>> = {
  srt: ['vtt', 'ass'],
  vtt: ['srt', 'ass'],
  ass: ['srt', 'vtt'],
  ssa: ['srt', 'vtt'],
  sub: ['srt', 'vtt', 'ass'],
};
const PAIRS = SUBTITLE_FORMATS.flatMap((source) => TARGETS[source].map((target) => [source, target] as const));
const authored = (source: string): Buffer => fs.readFileSync(path.join(FIXTURES, `authored.${source}`));
/** Cues each authored file holds (the comment lines of the SubStation Alpha files are not cues). */
const AUTHORED_CUES: Readonly<Record<SubtitleFormat, number>> = { srt: 5, vtt: 5, ass: 5, ssa: 5, sub: 6 };

async function convert(input: Buffer, source: string, target: string, name = `sample.${source}`) {
  const result = await dispatchConversion(input, source, target, {}, name);
  return { text: result.buffer.toString('utf-8'), result };
}

describe('the registry offers the subtitle pairs', () => {
  it('lists five formats in the subtitle category, and the eleven pairs FFmpeg serves', () => {
    expect(SUBTITLE_FORMATS.map((id) => FORMAT_REGISTRY[id]?.category)).toEqual(['subtitle', 'subtitle', 'subtitle', 'subtitle', 'subtitle']);
    expect(Object.fromEntries(SUBTITLE_FORMATS.map((id) => [id, FORMAT_REGISTRY[id].targetFormats]))).toEqual(
      Object.fromEntries(SUBTITLE_FORMATS.map((id) => [id, [...TARGETS[id]]]))
    );
    expect(PAIRS).toHaveLength(11);
    expect(getFormatByExtension('.SRT')?.mimeType).toBe('application/x-subrip');
  });
});

describe.skipIf(ffmpegMissing)('authored subtitle files convert and read back', () => {
  it.each(PAIRS)('%s -> %s keeps the cues, their times and their words', async (source, target) => {
    const { text, result } = await convert(authored(source), source, target);
    expect(result.engineUsed).toBe('native-ffmpeg');
    expect(result.mimeType).toBe(FORMAT_REGISTRY[target].mimeType);
    const expected = readSubtitle(source as SubtitleKind, authored(source).toString('utf-8'));
    expect(expected).toHaveLength(AUTHORED_CUES[source]);
    const comparison = compareCues(expected, readSubtitle(target as SubtitleKind, text), toleranceFor(target as SubtitleKind));
    expect(comparison).toMatchObject({ countMismatch: 0, timingMismatches: 0, textMismatches: 0 });
    expect(countSubtitleCues(target, text)).toBe(AUTHORED_CUES[source]);
  });

  it('writes milliseconds exactly between SubRip and WebVTT, and hundredths of a second into ASS', async () => {
    const toVtt = await convert(authored('srt'), 'srt', 'vtt');
    expect(toVtt.text.split('\n').filter((line) => line.includes('-->'))).toEqual([
      '00:01.000 --> 00:03.500',
      '00:04.001 --> 00:06.999',
      '00:05.000 --> 00:08.000',
      '01:02.345 --> 01:05.000',
      '01:02:03.456 --> 01:02:05.000',
    ]);
    const toAss = await convert(authored('srt'), 'srt', 'ass');
    expect(toAss.text.split('\n').filter((line) => line.startsWith('Dialogue:')).map((line) => line.split(',').slice(1, 3).join(' to '))).toEqual([
      '0:00:01.00 to 0:00:03.50',
      '0:00:04.00 to 0:00:07.00',
      '0:00:05.00 to 0:00:08.00',
      '0:01:02.35 to 0:01:05.01',
      '1:02:03.46 to 1:02:05.00',
    ]);
    expect(toAss.text.split(/\r?\n/)[1]).toBe('; Script generated by FFmpeg/Lavc');
  });

  it('keeps the words that FFmpeg alone would lose: braces of the text, an empty first line, a hard space, comments', async () => {
    const assToSrt = await convert(authored('ass'), 'ass', 'srt');
    expect(assToSrt.text).toContain('Over an hour in: {braces} stay');
    expect(assToSrt.text).not.toContain('not shown');
    const srtToAss = await convert(authored('srt'), 'srt', 'ass');
    expect(srtToAss.text).toContain('Over an hour in: \\{braces} stay');
    // A cue that opens with an override block and a line break would start with an empty line, which ends a cue in SubRip and WebVTT.
    const positioned = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}\nFirst\n\nSecond\n\n2\n00:00:03,000 --> 00:00:04,000\nLast\n');
    const vtt = await convert(positioned, 'srt', 'vtt');
    expect(readSubtitle('vtt', vtt.text).map((cue) => cue.text)).toEqual(['First Second', 'Last']);
    const nbsp = Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nNever&nbsp;gonna&nbsp;give\n');
    const srt = await convert(nbsp, 'vtt', 'srt');
    expect(srt.text).toContain('Never gonna give');
  });

  it('reads a file of 12 000 cues whole and in order', async () => {
    const cues = Array.from({ length: 12_000 }, (_, at) => {
      const start = at * 2000;
      const stamp = (ms: number) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');
      return `${at + 1}\n${stamp(start)} --> ${stamp(start + 1500)}\nCue number ${at + 1}\n`;
    });
    const { text } = await convert(Buffer.from(cues.join('\n')), 'srt', 'vtt');
    const written = readSubtitle('vtt', text);
    expect(written).toHaveLength(12_000);
    expect(written[11_999]).toMatchObject({ startMs: 23_998_000, endMs: 23_999_500, text: 'Cue number 12000' });
  });
});

describe.skipIf(ffmpegMissing)('the text of a subtitle file is read in its own encoding', () => {
  const srtOf = (words: string) => `1\n00:00:01,000 --> 00:00:03,000\n${words}\n\n2\n00:00:04,000 --> 00:00:05,500\nSecond cue\n`;

  it.each([
    ['UTF-8 with a byte order mark and CRLF line ends', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(srtOf('한국어 자막').replace(/\n/g, '\r\n'))]), '한국어 자막'],
    ['UTF-16 little endian with a byte order mark', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(srtOf('Grüße, 世界'), 'utf16le')]), 'Grüße, 世界'],
    ['UTF-16 big endian with a byte order mark', Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(srtOf('Grüße, 世界'), 'utf-16be')]), 'Grüße, 世界'],
  ])('reads %s', async (_label, bytes, words) => {
    const { text } = await convert(bytes, 'srt', 'vtt');
    expect(readSubtitle('vtt', text).map((cue) => cue.text)).toEqual([words, 'Second cue']);
  });

  it('detects a legacy code page, converts the text and says which code page it read', async () => {
    const korean = '안녕하세요. 오늘은 날씨가 좋네요. 자막 파일을 변환해 보겠습니다. 이 문장은 인코딩 감지를 위한 충분한 길이의 한국어 문장입니다.';
    const { text, result } = await convert(iconv.encode(srtOf(korean), 'cp949'), 'srt', 'vtt');
    expect(readSubtitle('vtt', text)[0].text).toBe(korean);
    expect(result.metadata?.warnings).toEqual([expect.stringMatching(/not valid UTF-8; it was read as /)]);
  });
});

describe.skipIf(ffmpegMissing)('a file that is not a subtitle file of its format is refused with a typed error', () => {
  const refuse = (input: Buffer, source: string, target: string) => dispatchConversion(input, source, target, {}, `file.${source}`);

  it('refuses a picture, a MicroDVD file and a WebVTT file named .srt, and a SubRip file named .vtt, before any engine reads them', async () => {
    const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.png'));
    const spoofed = { name: FileExtensionSpoofError.name, message: expect.stringContaining('incompatible with declared format') };
    await expect(refuse(png, 'srt', 'vtt')).rejects.toMatchObject(spoofed);
    await expect(refuse(authored('sub'), 'srt', 'vtt')).rejects.toMatchObject(spoofed);
    await expect(refuse(authored('vtt'), 'srt', 'ass')).rejects.toMatchObject(spoofed);
    await expect(refuse(authored('srt'), 'vtt', 'srt')).rejects.toMatchObject(spoofed);
    await expect(refuse(authored('ass'), 'sub', 'srt')).rejects.toMatchObject(spoofed);
  });

  it('refuses a VobSub .sub (an MPEG program stream) as a binary file', async () => {
    const vobsub = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01, 0x00, 0x00, 0x03, 0xf8]), Buffer.alloc(4096)]);
    await expect(refuse(vobsub, 'sub', 'srt')).rejects.toThrow(/File spoofing rejected for file "file\.sub"/);
  });

  it('refuses binary data after a valid head, a file with no cue, and a file over the size limit', async () => {
    const lateNul = Buffer.concat([authored('srt'), Buffer.alloc(80 * 1024, 0x20), Buffer.from([0x00, 0x01, 0x02]), Buffer.from('\nmore\n')]);
    await expect(refuse(lateNul, 'srt', 'vtt')).rejects.toMatchObject({ name: 'InvalidSubtitleInputError', reason: 'not-text', status: 422, refusalCode: 'malformed_input' });
    const noCue = Buffer.from('WEBVTT\n\nNOTE nothing but a header\n');
    await expect(refuse(noCue, 'vtt', 'srt')).rejects.toMatchObject({ reason: 'no-cues' });
    const tooLarge = Buffer.concat([authored('srt'), Buffer.alloc(MAX_SUBTITLE_BYTES, 0x20)]);
    const outcome = await refuse(tooLarge, 'srt', 'vtt').catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(PayloadLimitError);
    expect((outcome as PayloadLimitError).status).toBe(413);
  });

  it('refuses a UTF-16 file whose bytes are not valid UTF-16, a MicroDVD file of a frame rate only, and a script of ASS with no event', async () => {
    const odd = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nx\n', 'utf16le'), Buffer.from([0x00, 0xd8])]);
    await expect(refuse(odd, 'srt', 'vtt')).rejects.toMatchObject({ name: InvalidSubtitleInputError.name, reason: 'not-text' });
    const rateOnly = Buffer.from('{1}{1}25.000\n');
    await expect(refuse(rateOnly, 'sub', 'srt')).rejects.toMatchObject({ reason: 'no-cues' });
    const noEvents = Buffer.from('[Script Info]\nTitle: nothing\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n');
    await expect(refuse(noEvents, 'ass', 'srt')).rejects.toMatchObject({ reason: 'no-cues' });
  });

  it('answers with an unavailable engine when FFmpeg is not installed, never with a file of its own', async () => {
    const before = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = '/nonexistent/ffmpeg';
    try {
      const outcome = await refuse(authored('srt'), 'srt', 'vtt').catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(EngineUnavailableError);
      expect(outcome).toMatchObject({ engineName: 'ffmpeg', refusalCode: 'engine_unavailable' });
    } finally {
      if (before === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = before;
    }
  });
});

describe('the magic check of the five formats', () => {
  it.each(SUBTITLE_FORMATS)('.%s accepts its own authored file and nothing else', (format) => {
    for (const other of SUBTITLE_FORMATS) {
      expect(isFormatCompatibleWithMagicBytes(authored(other), format), `${other} file named .${format}`).toBe(other === format || (format === 'ass' && other === 'ssa') || (format === 'ssa' && other === 'ass'));
    }
    expect(isFormatCompatibleWithMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), format)).toBe(false);
  });
});

describe('what is repaired in the text FFmpeg writes', () => {
  it('removes an empty line inside a cue and keeps the one between cues', () => {
    const written = '1\n00:00:01,000 --> 00:00:02,000\n\nFirst\n\nSecond\n\n2\n00:00:03,000 --> 00:00:04,000\nLast\n\n';
    expect(repairSubtitleOutput(written, 'srt', 'srt')).toBe('1\n00:00:01,000 --> 00:00:02,000\nFirst\nSecond\n\n2\n00:00:03,000 --> 00:00:04,000\nLast\n\n');
  });

  it('keeps an empty cue, and leaves ASS text alone except for braces of SubRip text', () => {
    const empty = 'WEBVTT\n\n00:01.000 --> 00:02.000\n\n00:03.000 --> 00:04.000\nWords\n';
    expect(repairSubtitleOutput(empty, 'vtt', 'srt')).toBe(empty);
    const dialogue = 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}Top, {words} and {\\i1}more{\\i0}';
    expect(repairSubtitleOutput(dialogue, 'ass', 'srt')).toBe('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}Top, \\{words} and {\\i1}more{\\i0}');
    expect(repairSubtitleOutput(dialogue, 'ass', 'vtt')).toBe(dialogue);
  });

  it('removes the comments and untranslated overrides that SubStation Alpha leaves, and writes a brace of the text as a brace', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n{Translator note}{2c&H5D8FC3&\\c&H75BADB&}Words \\{{}kept} here\n';
    expect(repairSubtitleOutput(srt, 'srt', 'ass')).toBe('1\n00:00:01,000 --> 00:00:02,000\nWords {kept} here\n');
    expect(repairSubtitleOutput(srt, 'srt', 'vtt')).toBe('1\n00:00:01,000 --> 00:00:02,000\n{Translator note}{2c&H5D8FC3&\\c&H75BADB&}Words {kept} here\n');
  });
});

describe('crafted files cost time in proportion to their size', () => {
  // Each of these took 16 to 19 s on a file of about 200 KB before the passes were linear, and takes milliseconds now; the guard is a hang guard.
  const TIMING = '1\n00:00:01,000 --> 00:00:02,000\n';
  const DIALOGUE = 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,';

  it('repairs a cue followed by 100,000 empty lines in one pass', async () => {
    const written = `${TIMING}a${'\n'.repeat(100_000)}b\n`;
    expect(await expectNoHang('empty lines', () => repairSubtitleOutput(written, 'srt', 'ass'))).toBe(`${TIMING}a\nb\n`);
  });

  it('decides a run of 99,999 empty lines once when a line of 500,000 digits follows it', async () => {
    const written = `${TIMING}a${'\n'.repeat(99_999)}${'1'.repeat(500_000)}\n`;
    expect(await expectNoHang('empty lines before a long line', () => repairSubtitleOutput(written, 'srt', 'ass'))).toBe(`${TIMING}a\n${'1'.repeat(500_000)}\n`);
  });

  it('refuses a line over the length limit with the 413 of the other limits, before FFmpeg', () => {
    const header = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    const long = `${header}${DIALOGUE}a${'\\N'.repeat(99_999)}${'1'.repeat(500_000)}\n`;
    expect(() => prepareSubtitleInput(Buffer.from(long), 'ass')).toThrow(new RegExp(`at most ${MAX_SUBTITLE_LINE_CHARS} characters`));
  });

  it('removes and escapes blocks in braces in one pass on a line of 200,000 open braces', async () => {
    const open = '{'.repeat(200_000);
    expect(await expectNoHang('removed blocks', () => repairSubtitleOutput(`${TIMING}${open}\n`, 'srt', 'ass'))).toBe(`${TIMING}${open}\n`);
    expect(await expectNoHang('escaped blocks', () => repairSubtitleOutput(`${DIALOGUE}${open}`, 'ass', 'srt'))).toBe(`${DIALOGUE}${open}`);
  });

  it('finds the blocks a pass should and leaves the rest, as the pattern does', () => {
    expect(repairSubtitleOutput(`${TIMING}{{a}b{c}{d\n`, 'srt', 'ass')).toBe(`${TIMING}b{d\n`);
    expect(repairSubtitleOutput(`${DIALOGUE}{x\\y}{z}{u`, 'ass', 'srt')).toBe(`${DIALOGUE}{x\\y}\\{z}{u`);
  });

  it('refuses a file over the cue, line and line-break limits with the 413 of the other limits, before FFmpeg', async () => {
    const microdvd = Array.from({ length: 150_000 }, (_, at) => `{${at * 10}}{${at * 10 + 5}}x`).join('\n');
    const outcome = await expectNoHang('150,000 cues', () => {
      try {
        return prepareSubtitleInput(Buffer.from(microdvd), 'sub');
      } catch (error) {
        return error;
      }
    });
    expect(outcome).toMatchObject({ name: 'PayloadLimitError', status: 413, message: expect.stringContaining(`at most ${MAX_SUBTITLE_CUES} cues`) });
    const header = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    // Twelve lines of 9,000 breaks each: under the length limit of a line, over the limit of breaks.
    const breaks = `${header}${`${DIALOGUE}a${'\\N'.repeat(9_000)}b\n`.repeat(12)}`;
    expect(() => prepareSubtitleInput(Buffer.from(breaks), 'ass')).toThrow(new RegExp(`at most ${MAX_SUBTITLE_LINE_BREAKS} line breaks`));
    const lines = `${TIMING}a${'\n'.repeat(MAX_SUBTITLE_LINES + 1)}b\n`;
    expect(() => prepareSubtitleInput(Buffer.from(lines), 'srt')).toThrow(new RegExp(`at most ${MAX_SUBTITLE_LINES} lines`));
  });

  it('refuses a MicroDVD frame number that would print in exponent form', () => {
    const huge = '{1}{5}a\n{99999999999999999999}{}b\n';
    expect(() => prepareSubtitleInput(Buffer.from(huge), 'sub')).toThrow(/frame number of the MicroDVD file is above/);
  });

  it('closes the last open MicroDVD cue of a file with CRLF line ends', () => {
    const prepared = prepareSubtitleInput(Buffer.from('{1}{}a\r\n{5}{}b\r\n'), 'sub');
    expect(prepared.utf8.toString('utf-8')).toBe('{1}{}a\r\n{5}{125}b\r\n');
  });
});

describe.skipIf(ffmpegMissing)('crafted files through the dispatcher', () => {
  it('writes the end of a CRLF MicroDVD file\'s last cue as five seconds after its start, not as 1193 hours', async () => {
    const { text } = await convert(Buffer.from('{1}{}a\r\n{240}{}b\r\n'), 'sub', 'vtt');
    expect(readSubtitle('vtt', text).map((cue) => [cue.startMs, cue.endMs])).toEqual([[42, 10_010], [10_010, 15_015]]);
  });

  it('converts ASS cues of 99,000 line breaks together with the empty lines removed', async () => {
    const header = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    const input = Buffer.from(`${header}${'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a' + '\\N'.repeat(9_000) + 'b\n'}`.repeat(11));
    const { text } = await expectNoHang('99,000 line breaks', () => convert(input, 'ass', 'srt'));
    expect(readSubtitle('srt', text).map((cue) => cue.text)).toEqual(Array.from({ length: 11 }, () => 'a b'));
    expect(text.split('\n').filter((line) => line.trim() === '').length).toBeLessThan(15);
  });

  it('answers a reader failure with a fixed sentence that names no path and no address', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ffmpeg-'));
    const fake = path.join(dir, 'ffmpeg');
    fs.writeFileSync(fake, '#!/bin/sh\necho "[srt @ 0x7f12345678] Invalid data found in /var/data/easyconvert-subtitle-abc123/input.srt" >&2\nexit 1\n', { mode: 0o755 });
    const before = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = fake;
    try {
      const outcome = await dispatchConversion(authored('srt'), 'srt', 'vtt', {}, 'a.srt').catch((error: unknown) => error);
      expect(outcome).toMatchObject({ name: 'InvalidSubtitleInputError', status: 422, message: 'The .srt subtitle file could not be read: the subtitle reader stopped on it.' });
    } finally {
      if (before === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The real files whose conversion must match their source cue for cue (written by one tool, well formed, times after zero). */
const EXACT_SAMPLES: readonly { id: string; encoding?: string }[] = [
  { id: 'fate-ticket5032-rrn.srt' },
  { id: 'fate-empty-events-2167.srt' },
  { id: 'fate-webvtt-capability-tester.vtt' },
  { id: 'fate-webvtt-extended-tester.vtt' },
  { id: 'fate-webvtt-timestamp-map.vtt' },
  { id: 'fate-1ededcbd7b.ass' },
  { id: 'libass-sub1.ass' },
  { id: 'fate-a9-misc.ssa' },
  { id: 'popcorn-parser-ssa.ssa' },
  { id: 'fate-microdvd-capability-tester.sub' },
  { id: 'fate-cp1251-subtitles.sub', encoding: 'windows-1251' },
];
/**
 * Real files that test the readers of other tools on purpose: bad syntax, cue numbers inside the text, times before zero, tags
 * the converter has no meaning for. They convert to a file of cues; how the cues of such a file are read is each tool's own.
 */
const ROBUSTNESS_SAMPLES = ['fate-subrip-capability-tester.srt', 'fate-madness.srt', 'fate-badsyntax.srt', 'gaupol-subrip.srt', 'gaupol-ass.ass', 'gaupol-ssa.ssa', 'gaupol-microdvd.sub'] as const;

describe.skipIf(ffmpegMissing)('real subtitle files convert and read back', () => {
  for (const { id, encoding } of EXACT_SAMPLES) {
    it(`${id}: every cue, time and word is the source's`, { timeout: 120_000 }, async (ctx) => {
      const sample = await requireRealworldSample(ctx, id);
      const source = sample.format as SubtitleFormat;
      const expected = readSubtitle(source, new TextDecoder(encoding ?? 'utf-8').decode(sample.bytes));
      expect(expected.length).toBeGreaterThan(0);
      for (const target of TARGETS[source]) {
        const { text } = await convert(sample.bytes, source, target, id);
        const comparison = compareCues(expected, readSubtitle(target as SubtitleKind, text), toleranceFor(target as SubtitleKind));
        expect(comparison, `${id} to ${target}`).toMatchObject({ countMismatch: 0, timingMismatches: 0, textMismatches: 0 });
      }
    });
  }

  for (const id of ROBUSTNESS_SAMPLES) {
    it(`${id} converts to every target with cues in it and no empty cue`, { timeout: 120_000 }, async (ctx) => {
      const sample = await requireRealworldSample(ctx, id);
      const source = sample.format as SubtitleFormat;
      for (const target of TARGETS[source]) {
        const { text } = await convert(sample.bytes, source, target, id);
        const cues = readSubtitle(target as SubtitleKind, text);
        expect(cues.length, `${id} to ${target}`).toBeGreaterThan(0);
        expect(countSubtitleCues(target, text)).toBeGreaterThanOrEqual(cues.length);
      }
    });
  }

  it('gives the last MicroDVD cue that names no end five seconds and says so', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'fate-microdvd-capability-tester.sub');
    const { text, result } = await convert(sample.bytes, 'sub', 'srt', 'tester.sub');
    const last = readSubtitle('srt', text).at(-1);
    expect(last).toMatchObject({ startMs: 192_000, endMs: 197_000, text: '...to the end of the presentation' });
    expect(result.metadata?.warnings).toEqual([expect.stringContaining('named no end')]);
  });
});
