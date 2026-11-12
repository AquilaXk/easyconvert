import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  FORMAT_REGISTRY,
  getAvailableTargetFormats,
} from '../src/lib/registry';
import { REGISTRY_STATS } from '../src/lib/registry-stats';
import { buildOpenApiDocument } from '../src/lib/api/openapi';
import {
  STATS_END_MARKER,
  STATS_START_MARKER,
  buildGeneratedRegistryStats,
   renderRegistryStatsBlock,
  replaceRegistryStatsBlock,
  type GeneratedRegistryStats,
} from '../scripts/registry-stats';
import { API_DOC_SUBPAGES } from '../src/components/api-docs/topics';

const ROOT_DIR = path.resolve(__dirname, '..');
const GENERATED_JSON_PATH = path.join(ROOT_DIR, 'docs', 'generated', 'registry-stats.json');
const README_EN_PATH = path.join(ROOT_DIR, 'README.md');
const README_KO_PATH = path.join(ROOT_DIR, 'README.ko.md');

const UNREGISTERED_EXTENSIONS = ['xlsb', 'vsdx', 'ply', 'sql', 'plist', 'hwt', 'hwtx'];

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx|md)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractMarkerBlock(markdown: string): string {
  const start = markdown.indexOf(STATS_START_MARKER);
  const end = markdown.indexOf(STATS_END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    return '';
  }
  return markdown.slice(start, end + STATS_END_MARKER.length);
}

function parseMarkdownTableRows(block: string): Array<{
  label: string;
  id: string;
  count: number;
  extensions: string[];
}> {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));
  const dataLines = lines.slice(2);
  return dataLines.map((line) => {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const categoryMatch = /^\*\*(.+)\*\*\s+\(`([a-z]+)`\)$/.exec(cells[0] ?? '');
    const count = Number.parseInt(cells[1] ?? '', 10);
    const extensions = (cells[2] ?? '')
      .split(',')
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean);
    return {
      label: categoryMatch?.[1] ?? '',
      id: categoryMatch?.[2] ?? '',
      count,
      extensions,
    };
  });
}

function normalizeApiPath(rawPath: string): string {
  const withoutQuery = rawPath.split('?')[0].replace(/[.,;:`'")\]]+$/, '');
  return withoutQuery
    .replace(/\/\[\[\.\.\.([a-zA-Z0-9_]+)\]\]/g, '/{$1}')
    .replace(/\/\[\.\.\.([a-zA-Z0-9_]+)\]/g, '/{$1}')
    .replace(/\/\[([a-zA-Z0-9_]+)\]/g, '/{$1}')
    .replace(/\/:([a-zA-Z0-9_]+)/g, '/{$1}')
    .replace(/\/<([a-zA-Z0-9_]+)>/g, '/{$1}');
}

function extractApiPaths(markdown: string): string[] {
  const matches = markdown.match(/\/api\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]+/g) ?? [];
  const normalized = matches
    .map(normalizeApiPath)
    .filter((p) => p.length > '/api/'.length && !p.endsWith('/*'));
  return Array.from(new Set(normalized));
}

function extractApiDocSlugs(markdown: string): string[] {
  const matches = Array.from(markdown.matchAll(/\/api-docs\/([A-Za-z0-9_-]+)/g), (m) => m[1]);
  return Array.from(new Set(matches));
}

function extractSrcPaths(markdown: string): string[] {
  const matches = Array.from(
    markdown.matchAll(/\b(src\/[A-Za-z0-9._[\]/-]+)(?!\*)/g),
    (m) => m[1].replace(/[.,;:`'")\]]+$/, '')
  ).filter((p) => !p.endsWith('/'));
  return Array.from(new Set(matches));
}

function hasAppRouteHandler(normalizedPath: string): boolean {
  const segments = normalizedPath
    .replace(/^\/api\//, '')
    .split('/')
    .filter(Boolean);
  const apiRoot = path.join(ROOT_DIR, 'src', 'app', 'api');

  function search(dir: string, index: number): boolean {
    if (!fs.existsSync(dir)) return false;
    if (index === segments.length) {
      return fs.existsSync(path.join(dir, 'route.ts'));
    }
    const seg = segments[index];
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const entry of entries) {
      if (entry.name.startsWith('[[...') && entry.name.endsWith(']]')) {
        if (fs.existsSync(path.join(dir, entry.name, 'route.ts'))) return true;
      }
      if (entry.name.startsWith('[...') && entry.name.endsWith(']')) {
        if (fs.existsSync(path.join(dir, entry.name, 'route.ts'))) return true;
      }
      const isParam = seg.startsWith('{') && seg.endsWith('}');
      if (entry.name === seg || (isParam && entry.name.startsWith('[') && entry.name.endsWith(']'))) {
        if (search(path.join(dir, entry.name), index + 1)) return true;
      }
    }
    return false;
  }

  return search(apiRoot, 0);
}

describe('Registry stats, CATEGORIES, and README drift guard (#467)', () => {
  const allFormats = Object.values(FORMAT_REGISTRY);
  const registeredExtensions = new Set(allFormats.map((f) => f.extension.toLowerCase()));

  it('keeps REGISTRY_STATS, CATEGORIES, and docs/generated/registry-stats.json aligned with FORMAT_REGISTRY', () => {
    const expectedPairCount = allFormats.reduce(
      (sum, f) => sum + getAvailableTargetFormats(f.id).length,
      0
    );
    expect(REGISTRY_STATS.formatCount).toBe(allFormats.length);
    expect(REGISTRY_STATS.categoryCount).toBe(CATEGORY_ORDER.length);
    expect(REGISTRY_STATS.pairCount).toBe(expectedPairCount);

    expect(CATEGORIES).toEqual(
      CATEGORY_ORDER.map((id) => ({
        id,
        label: CATEGORY_LABELS[id],
        count: allFormats.filter((f) => f.category === id).length,
      }))
    );

    expect(fs.existsSync(GENERATED_JSON_PATH)).toBe(true);
    const committedJson = JSON.parse(
      fs.readFileSync(GENERATED_JSON_PATH, 'utf8')
    ) as GeneratedRegistryStats;
    expect(committedJson).toEqual(buildGeneratedRegistryStats());
    expect(committedJson.formatCount).toBe(REGISTRY_STATS.formatCount);
    expect(committedJson.categoryCount).toBe(REGISTRY_STATS.categoryCount);
    expect(committedJson.pairCount).toBe(REGISTRY_STATS.pairCount);
  });

  it('keeps README.md and README.ko.md marker blocks and totals synchronized with REGISTRY_STATS', () => {
    const readmeEn = fs.readFileSync(README_EN_PATH, 'utf8');
    const readmeKo = fs.readFileSync(README_KO_PATH, 'utf8');
    const expectedBlock = renderRegistryStatsBlock();

    const blockEn = extractMarkerBlock(readmeEn);
    const blockKo = extractMarkerBlock(readmeKo);
    expect(blockEn).toBe(expectedBlock);
    expect(blockKo).toBe(expectedBlock);

    const formattedPairs = REGISTRY_STATS.pairCount.toLocaleString('en-US');
    for (const [name, content] of [
      ['README.md', readmeEn],
      ['README.ko.md', readmeKo],
    ] as const) {
      expect(content, name).toContain(String(REGISTRY_STATS.formatCount));
      expect(content, name).toContain(String(REGISTRY_STATS.categoryCount));
      expect(content, name).toContain(formattedPairs);
    }

    const syntheticStats: GeneratedRegistryStats = {
      ...buildGeneratedRegistryStats(),
      formatCount: 999,
      categoryCount: 15,
      pairCount: 9876,
    };
    const rewrittenEn = replaceRegistryStatsBlock(readmeEn, syntheticStats);
    expect(rewrittenEn).toContain('**999 file formats** and **9,876 conversion pairs** in **15 categories**');
    expect(rewrittenEn).toContain('**999 Formats Across 15 Categories**');
    expect(rewrittenEn).toContain('(`9,876` source-to-target pairs)');
    expect(rewrittenEn).toContain('## Supported Format Matrix (15 Categories)');
    expect(rewrittenEn).toContain('# 999 canonical format definitions & options');

    const rewrittenKo = replaceRegistryStatsBlock(readmeKo, syntheticStats);
    expect(rewrittenKo).toContain('**15개 카테고리**, **999개 포맷**, **9,876개 변환 쌍**');
    expect(rewrittenKo).toContain('**15개 카테고리 999개 포맷 지원**');
    expect(rewrittenKo).toContain('`9,876`개 변환 쌍을 지원해요');
    expect(rewrittenKo).toContain('## 지원 포맷 매트릭스 (15개 카테고리)');
    expect(rewrittenKo).toContain('# 999개 표준 포맷 정의 및 옵션 스키마');
  });

  it('lists only registered format extensions in README tables and prose', () => {
    for (const [name, filePath] of [
      ['README.md', README_EN_PATH],
      ['README.ko.md', README_KO_PATH],
    ] as const) {
      const content = fs.readFileSync(filePath, 'utf8');
      const rows = parseMarkdownTableRows(extractMarkerBlock(content));
      expect(rows, name).toHaveLength(REGISTRY_STATS.categoryCount);

      const rowSum = rows.reduce((sum, row) => sum + row.count, 0);
      expect(rowSum, name).toBe(REGISTRY_STATS.formatCount);

      for (const row of rows) {
        const expectedCat = CATEGORIES.find((c) => c.id === row.id);
        expect(expectedCat, `${name}:${row.id}`).toBeDefined();
        expect(row.label, `${name}:${row.id}`).toBe(expectedCat?.label);
        expect(row.count, `${name}:${row.id}`).toBe(expectedCat?.count);
        expect(row.extensions.length, `${name}:${row.id}`).toBeGreaterThan(0);
        for (const ext of row.extensions) {
          expect(registeredExtensions.has(ext), `${name} extension ${ext}`).toBe(true);
        }
      }

      for (const unregistered of UNREGISTERED_EXTENSIONS) {
        const tokenRegex = new RegExp(`\\b${unregistered}\\b`, 'i');
        expect(tokenRegex.test(content), `${name} mentions unregistered ${unregistered}`).toBe(false);
      }
    }
  });

  it('contains zero stale counts, BullMQ claims, /api/v2 paths, or action=init tokens across READMEs, OpenAPI definitions, src/components, and src/app', () => {
    const filesToCheck = [
      README_EN_PATH,
      README_KO_PATH,
      ...collectSourceFiles(path.join(ROOT_DIR, 'src', 'lib', 'api', 'openapi')),
      ...collectSourceFiles(path.join(ROOT_DIR, 'src', 'components')),
      ...collectSourceFiles(path.join(ROOT_DIR, 'src', 'app')),
    ];

    const stalePattern = /\b292\b|2,156|BullMQ|\/api\/v2\b|action=init(?!iate)/;
    const violations: string[] = [];

    for (const file of filesToCheck) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        if (stalePattern.test(line)) {
          violations.push(`${path.relative(ROOT_DIR, file)}:${idx + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);

    for (const [name, filePath] of [
      ['README.md', README_EN_PATH],
      ['README.ko.md', README_KO_PATH],
    ] as const) {
      const text = fs.readFileSync(filePath, 'utf8');
      expect(text, name).not.toMatch(/21 test|192|action=part\b|\bv2\//i);
    }
  });

  it('ensures every /api/..., /api-docs/..., and src/... path in README.md and README.ko.md exists', () => {
    const spec = buildOpenApiDocument();
    const openApiPaths = new Set(Object.keys(spec.paths));
    const validApiDocSlugs = new Set<string>(API_DOC_SUBPAGES.map((t) => t.slug));

    for (const [name, filePath] of [
      ['README.md', README_EN_PATH],
      ['README.ko.md', README_KO_PATH],
    ] as const) {
      const text = fs.readFileSync(filePath, 'utf8');
      const apiPaths = extractApiPaths(text);
      expect(apiPaths.length, name).toBeGreaterThan(0);

      const missingApi = apiPaths.filter(
        (apiPath) => !openApiPaths.has(apiPath) && !hasAppRouteHandler(apiPath)
      );
      expect(missingApi, name).toEqual([]);

      const docSlugs = extractApiDocSlugs(text);
      expect(docSlugs.length, name).toBeGreaterThan(0);
      expect(docSlugs.filter((slug) => !validApiDocSlugs.has(slug)), name).toEqual([]);

      const srcPaths = extractSrcPaths(text);
      expect(srcPaths.length, name).toBeGreaterThan(0);
      expect(srcPaths.filter((relPath) => !fs.existsSync(path.join(ROOT_DIR, relPath))), name).toEqual([]);
    }
  });
});

