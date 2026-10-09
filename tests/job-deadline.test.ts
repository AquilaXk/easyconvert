import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  JOB_DEADLINE_DEFAULTS,
  JOB_DEADLINE_ENV,
  conversionDeadlineMs,
  jobDeadlineFamily,
  jobDeadlineMs,
  jobDeadlineSettings,
} from '../src/lib/queue/job-deadline';
import { CONFIG_SCHEMA } from '../src/lib/config/schema';
import { ConfigurationError, parseConfig } from '../src/lib/config';
import { TIER_MAX_PAGES } from '../src/lib/conversions/page-range';

/**
 * The deadline of a conversion job is one pure function of the owner's tier and the size of the work. These
 * tests state the numbers literally (they are the documented defaults) so a changed default is a visible edit.
 */

const MIB = 1024 * 1024;
const FREE_BASE = 60_000;
const FREE_MAX = 600_000;
const PER_PAGE = 10_000;
const PER_MIB = 2_000;
const PER_MEDIA_SECOND = 3_000;

describe('jobDeadlineMs defaults', () => {
  it('gives an empty input the base of its tier', () => {
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: 0 })).toBe(FREE_BASE);
    expect(jobDeadlineMs({ tier: 'pro', family: 'bytes', inputBytes: 0 })).toBe(120_000);
    expect(jobDeadlineMs({ tier: 'enterprise', family: 'bytes', inputBytes: 0 })).toBe(180_000);
  });

  it('adds the per-MiB allowance and rounds a partial MiB up', () => {
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: MIB })).toBe(FREE_BASE + PER_MIB);
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: 10 * MIB })).toBe(FREE_BASE + 10 * PER_MIB);
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: 10 * MIB + 1 })).toBe(FREE_BASE + 11 * PER_MIB);
  });

  it('stops at the maximum of the tier, exactly at the boundary', () => {
    const mibsToMax = (FREE_MAX - FREE_BASE) / PER_MIB;
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: (mibsToMax - 1) * MIB })).toBe(FREE_MAX - PER_MIB);
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: mibsToMax * MIB })).toBe(FREE_MAX);
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: mibsToMax * MIB + 1 })).toBe(FREE_MAX);
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: 10_000 * MIB })).toBe(FREE_MAX);
    expect(jobDeadlineMs({ tier: 'pro', family: 'bytes', inputBytes: 10_000 * MIB })).toBe(1_800_000);
    expect(jobDeadlineMs({ tier: 'enterprise', family: 'bytes', inputBytes: 10_000 * MIB })).toBe(3_600_000);
  });

  it('treats an unknown or missing tier as the free tier and reads a tier in any case', () => {
    const free = jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: MIB });
    expect(jobDeadlineMs({ family: 'bytes', inputBytes: MIB })).toBe(free);
    expect(jobDeadlineMs({ tier: 'platinum', family: 'bytes', inputBytes: MIB })).toBe(free);
    expect(jobDeadlineMs({ tier: 'PRO', family: 'bytes', inputBytes: MIB })).toBe(
      jobDeadlineMs({ tier: 'pro', family: 'bytes', inputBytes: MIB })
    );
  });

  it('allows a document the pages it has, and the page limit of the tier when the count is unknown', () => {
    expect(jobDeadlineMs({ tier: 'free', family: 'pages', inputBytes: 0, pages: 1 })).toBe(FREE_BASE + PER_PAGE);
    expect(jobDeadlineMs({ tier: 'free', family: 'pages', inputBytes: 0, pages: 20 })).toBe(FREE_BASE + 20 * PER_PAGE);
    expect(jobDeadlineMs({ tier: 'free', family: 'pages', inputBytes: 0 })).toBe(FREE_BASE + TIER_MAX_PAGES.free * PER_PAGE);
    expect(TIER_MAX_PAGES.free).toBe(50);
  });

  it('never counts more pages than the tier converts', () => {
    expect(jobDeadlineMs({ tier: 'free', family: 'pages', inputBytes: 0, pages: 5000 })).toBe(
      jobDeadlineMs({ tier: 'free', family: 'pages', inputBytes: 0, pages: TIER_MAX_PAGES.free })
    );
  });

  it('sums the page, size and media allowances before the maximum applies', () => {
    expect(jobDeadlineMs({ tier: 'free', family: 'pages', inputBytes: 3 * MIB, pages: 4 })).toBe(
      FREE_BASE + 3 * PER_MIB + 4 * PER_PAGE
    );
    expect(jobDeadlineMs({ tier: 'free', family: 'media', inputBytes: 5 * MIB, mediaSeconds: 30 })).toBe(
      FREE_BASE + 5 * PER_MIB + 30 * PER_MEDIA_SECOND
    );
    expect(jobDeadlineMs({ tier: 'free', family: 'media', inputBytes: 5 * MIB })).toBe(FREE_BASE + 5 * PER_MIB);
  });

  it('gives work of unknown size the maximum of the tier, never no limit', () => {
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes' })).toBe(FREE_MAX);
    expect(jobDeadlineMs({ tier: 'pro', family: 'media' })).toBe(1_800_000);
  });

  it('never shrinks when the work grows', () => {
    let previous = 0;
    for (const mibs of [0, 1, 2, 7, 50, 249, 270, 5000]) {
      const value = jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: mibs * MIB });
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('keeps the OCR page budget inside the deadline of a full-page-limit document, with the OCR share at 90 percent', () => {
    const ocrBudgetPerPageMs = 10_000;
    for (const tier of ['free', 'pro', 'enterprise']) {
      const pages = TIER_MAX_PAGES[tier];
      const deadline = jobDeadlineMs({ tier, family: 'pages', inputBytes: 0, pages });
      const settings = jobDeadlineSettings();
      const wanted = settings.baseMs[tier] + pages * ocrBudgetPerPageMs;
      // Free fits whole; the larger tiers are cut by their maximum, which is stated here, not hidden.
      expect(deadline).toBe(Math.min(wanted, settings.maxMs[tier]));
    }
    expect(jobDeadlineMs({ tier: 'free', family: 'pages', inputBytes: 0, pages: 50 }) * 0.9).toBeGreaterThanOrEqual(50 * 10_000);
  });
});

describe('jobDeadlineMs input checks', () => {
  it.each([
    ['a negative size', { inputBytes: -1 }],
    ['a size that is not finite', { inputBytes: Number.POSITIVE_INFINITY }],
    ['a size that is NaN', { inputBytes: Number.NaN }],
    ['a page count of zero', { inputBytes: 0, pages: 0 }],
    ['a fractional page count', { inputBytes: 0, pages: 1.5 }],
    ['a negative media length', { inputBytes: 0, mediaSeconds: -1 }],
    ['a media length that is NaN', { inputBytes: 0, mediaSeconds: Number.NaN }],
  ])('refuses %s instead of guessing', (_label, extra) => {
    expect(() => jobDeadlineMs({ tier: 'free', family: 'pages', ...extra } as never)).toThrow(RangeError);
  });
});

describe('jobDeadlineFamily', () => {
  it('counts documents, presentations, spreadsheets and ebooks by page', () => {
    for (const source of ['pdf', 'docx', 'pptx', 'xlsx', 'epub']) {
      expect(jobDeadlineFamily(source, 'txt'), source).toBe('pages');
    }
  });

  it('counts audio and video by media length, whichever side is the media', () => {
    expect(jobDeadlineFamily('mp4', 'webm')).toBe('media');
    expect(jobDeadlineFamily('wav', 'mp3')).toBe('media');
    expect(jobDeadlineFamily('mp4', 'jpg')).toBe('media');
  });

  it('counts everything else by size', () => {
    for (const [source, target] of [['png', 'webp'], ['zip', 'tar'], ['csv', 'json']]) {
      expect(jobDeadlineFamily(source, target), source).toBe('bytes');
    }
  });
});

describe('conversionDeadlineMs', () => {
  it('derives the family from the formats and uses the size of the file', () => {
    expect(conversionDeadlineMs({ tier: 'free', sourceFormat: 'png', targetFormat: 'webp', inputBytes: 2 * MIB })).toBe(
      FREE_BASE + 2 * PER_MIB
    );
    expect(conversionDeadlineMs({ tier: 'free', sourceFormat: '.PDF', targetFormat: 'txt', inputBytes: 2 * MIB })).toBe(
      FREE_BASE + 2 * PER_MIB + TIER_MAX_PAGES.free * PER_PAGE
    );
  });

  it('gives a job without a known size the maximum of the tier', () => {
    expect(conversionDeadlineMs({ tier: 'free', sourceFormat: 'bin', targetFormat: 'bin' })).toBe(FREE_MAX);
    expect(conversionDeadlineMs({ tier: 'free', sourceFormat: 'bin', targetFormat: 'bin', inputBytes: 0 })).toBe(FREE_BASE);
  });
});

describe('jobDeadlineSettings', () => {
  it('returns the documented defaults from an empty environment', () => {
    const settings = jobDeadlineSettings({});
    expect(settings).toEqual({
      baseMs: { free: 60_000, pro: 120_000, enterprise: 180_000 },
      maxMs: { free: 600_000, pro: 1_800_000, enterprise: 3_600_000 },
      perPageMs: 10_000,
      perMibMs: 2_000,
      perMediaSecondMs: 3_000,
    });
  });

  it('reads every setting from the environment and treats a blank value as unset', () => {
    const settings = jobDeadlineSettings({
      JOB_DEADLINE_BASE_MS_FREE: '5000',
      JOB_DEADLINE_MAX_MS_FREE: '9000',
      JOB_DEADLINE_PER_PAGE_MS: '7',
      JOB_DEADLINE_PER_MIB_MS: '11',
      JOB_DEADLINE_PER_MEDIA_SECOND_MS: '13',
      JOB_DEADLINE_BASE_MS_PRO: '  ',
    });
    expect(settings.baseMs.free).toBe(5000);
    expect(settings.maxMs.free).toBe(9000);
    expect(settings.perPageMs).toBe(7);
    expect(settings.perMibMs).toBe(11);
    expect(settings.perMediaSecondMs).toBe(13);
    expect(settings.baseMs.pro).toBe(120_000);
  });

  it.each(['abc', '1.5', '-1', '0', '99999999999999999999', '1e3'])('refuses the malformed value %j instead of using a default', (value) => {
    expect(() => jobDeadlineSettings({ JOB_DEADLINE_PER_PAGE_MS: value })).toThrow(/JOB_DEADLINE_PER_PAGE_MS/);
  });

  it('refuses a base above the maximum of its tier', () => {
    expect(() => jobDeadlineSettings({ JOB_DEADLINE_BASE_MS_FREE: '700000' })).toThrow(/JOB_DEADLINE_BASE_MS_FREE/);
  });

  it('applies the environment in the deadline', () => {
    const env = { JOB_DEADLINE_BASE_MS_FREE: '1000', JOB_DEADLINE_MAX_MS_FREE: '4000', JOB_DEADLINE_PER_MIB_MS: '500' };
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: 2 * MIB }, jobDeadlineSettings(env))).toBe(2000);
    expect(jobDeadlineMs({ tier: 'free', family: 'bytes', inputBytes: 100 * MIB }, jobDeadlineSettings(env))).toBe(4000);
  });
});

describe('the settings are documented configuration', () => {
  const byName = new Map(CONFIG_SCHEMA.map((spec) => [spec.name, spec]));
  const configDoc = readFileSync(path.resolve(__dirname, '..', 'docs', 'configuration.md'), 'utf8');

  it('declares every deadline variable in the configuration schema with the default the code uses', () => {
    expect(Object.values(JOB_DEADLINE_ENV).length).toBe(9);
    for (const [key, name] of Object.entries(JOB_DEADLINE_ENV)) {
      const spec = byName.get(name);
      expect(spec, name).toBeDefined();
      expect(spec?.default, name).toBe(JOB_DEADLINE_DEFAULTS[key as keyof typeof JOB_DEADLINE_ENV]);
      expect(spec?.roles, name).toEqual(['web', 'worker']);
      expect(configDoc, name).toContain(name);
    }
  });
});

describe('start-up configuration check of the deadline settings', () => {
  it('stops the process for a base above the maximum of its tier, naming the variable and not the value', () => {
    try {
      parseConfig({ JOB_DEADLINE_BASE_MS_PRO: '3000000' });
      throw new Error('parseConfig accepted a base above the maximum');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const failure = (error as ConfigurationError).failures.find((f) => f.variable === 'JOB_DEADLINE_BASE_MS_PRO');
      expect(failure?.rule).toBe('must not exceed JOB_DEADLINE_MAX_MS_PRO');
      expect((error as Error).message).not.toContain('3000000');
    }
  });

  it('stops the process for a malformed value, with no fallback to the default', () => {
    expect(() => parseConfig({ JOB_DEADLINE_PER_PAGE_MS: '10s' })).toThrow(/JOB_DEADLINE_PER_PAGE_MS/);
  });

  it('accepts the defaults and a consistent override', () => {
    expect(parseConfig({}).JOB_DEADLINE_MAX_MS_FREE).toBe(600_000);
    expect(parseConfig({ JOB_DEADLINE_BASE_MS_FREE: '1000', JOB_DEADLINE_MAX_MS_FREE: '2000' }).JOB_DEADLINE_MAX_MS_FREE).toBe(2000);
  });
});
