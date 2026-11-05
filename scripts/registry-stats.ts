import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FormatCategory } from '../src/lib/types';
import { REGISTRY_STATS } from '../src/lib/registry-stats';

export const STATS_START_MARKER = '<!-- registry-stats:start -->';
export const STATS_END_MARKER = '<!-- registry-stats:end -->';

export interface GeneratedCategoryStat {
  id: FormatCategory;
  label: string;
  count: number;
  formats: string[];
  extensions: string[];
}

export interface GeneratedRegistryStats {
  formatCount: number;
  categoryCount: number;
  pairCount: number;
  categories: GeneratedCategoryStat[];
}

export function buildGeneratedRegistryStats(): GeneratedRegistryStats {
  const categories: GeneratedCategoryStat[] = REGISTRY_STATS.categories.map((cat) => {
    const formats = cat.formats.map((f) => f.id).sort((a, b) => a.localeCompare(b));
    const extensions = Array.from(new Set(cat.formats.map((f) => f.extension))).sort((a, b) =>
      a.localeCompare(b)
    );
    return {
      id: cat.id,
      label: cat.label,
      count: cat.count,
      formats,
      extensions,
    };
  });

  return {
    formatCount: REGISTRY_STATS.formatCount,
    categoryCount: REGISTRY_STATS.categoryCount,
    pairCount: REGISTRY_STATS.pairCount,
    categories,
  };
}

export function renderRegistryStatsBlock(
  stats: GeneratedRegistryStats = buildGeneratedRegistryStats()
): string {
  const rows = stats.categories.map((cat) => {
    const extList = cat.extensions.map((ext) => ext.toUpperCase()).join(', ');
    return `| **${cat.label}** (\`${cat.id}\`) | ${cat.count} | ${extList} |`;
  });

  return [
    STATS_START_MARKER,
    '| Category | Format Count | Supported Extensions |',
    '| :--- | ---: | :--- |',
    ...rows,
    STATS_END_MARKER,
  ].join('\n');
}

function replaceHeadlineStats(markdown: string, stats: GeneratedRegistryStats): string {
  const formattedPairs = stats.pairCount.toLocaleString('en-US');
  return markdown
    .replace(
      /\*\*\d+ file formats\*\* and \*\*[\d,]+ conversion pairs\*\* in \*\*\d+ categories\*\*/g,
      `**${stats.formatCount} file formats** and **${formattedPairs} conversion pairs** in **${stats.categoryCount} categories**`
    )
    .replace(
      /\*\*\d+ Formats Across \d+ Categories\*\*/g,
      `**${stats.formatCount} Formats Across ${stats.categoryCount} Categories**`
    )
    .replace(
      /\(`[\d,]+` source-to-target pairs\)/g,
      `(\`${formattedPairs}\` source-to-target pairs)`
    )
    .replace(
      /## Supported Format Matrix \(\d+ Categories\)/g,
      `## Supported Format Matrix (${stats.categoryCount} Categories)`
    )
    .replace(
      /# \d+ canonical format definitions & options/g,
      `# ${stats.formatCount} canonical format definitions & options`
    )
    .replace(
      /\*\*\d+개 카테고리\*\*, \*\*\d+개 포맷\*\*, \*\*[\d,]+개 변환 쌍\*\*/g,
      `**${stats.categoryCount}개 카테고리**, **${stats.formatCount}개 포맷**, **${formattedPairs}개 변환 쌍**`
    )
    .replace(
      /\*\*\d+개 카테고리 \d+개 포맷 지원\*\*/g,
      `**${stats.categoryCount}개 카테고리 ${stats.formatCount}개 포맷 지원**`
    )
    .replace(
      /`[\d,]+`개 변환 쌍을 지원합니다/g,
      `\`${formattedPairs}\`개 변환 쌍을 지원합니다`
    )
    .replace(
      /## 지원 포맷 매트릭스 \(\d+개 카테고리\)/g,
      `## 지원 포맷 매트릭스 (${stats.categoryCount}개 카테고리)`
    )
    .replace(
      /# \d+개 표준 포맷 정의 및 옵션 스키마/g,
      `# ${stats.formatCount}개 표준 포맷 정의 및 옵션 스키마`
    );
}

export function replaceRegistryStatsBlock(
  markdown: string,
  stats: GeneratedRegistryStats = buildGeneratedRegistryStats()
): string {
  const startIdx = markdown.indexOf(STATS_START_MARKER);
  const endIdx = markdown.indexOf(STATS_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error('Missing registry-stats markers in markdown document.');
  }
  const block = renderRegistryStatsBlock(stats);
  const withTable =
    markdown.slice(0, startIdx) +
    block +
    markdown.slice(endIdx + STATS_END_MARKER.length);
  return replaceHeadlineStats(withTable, stats);
}

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUTPUT_PATH = path.join(ROOT_DIR, 'docs', 'generated', 'registry-stats.json');
const README_FILES = ['README.md', 'README.ko.md'];

export function generateRegistryDocs(check = false): boolean {
  const stats = buildGeneratedRegistryStats();
  const expectedJson = `${JSON.stringify(stats, null, 2)}\n`;
  let drifted = false;

  if (check) {
    const actualJson = fs.existsSync(JSON_OUTPUT_PATH)
      ? fs.readFileSync(JSON_OUTPUT_PATH, 'utf8')
      : undefined;
    if (actualJson !== expectedJson) {
      drifted = true;
    }
  } else {
    fs.mkdirSync(path.dirname(JSON_OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(JSON_OUTPUT_PATH, expectedJson, 'utf8');
  }

  for (const relPath of README_FILES) {
    const fullPath = path.join(ROOT_DIR, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const current = fs.readFileSync(fullPath, 'utf8');
    if (!current.includes(STATS_START_MARKER) || !current.includes(STATS_END_MARKER)) {
      if (check) drifted = true;
      continue;
    }
    const updated = replaceRegistryStatsBlock(current, stats);
    if (check) {
      if (current !== updated) drifted = true;
    } else if (current !== updated) {
      fs.writeFileSync(fullPath, updated, 'utf8');
    }
  }

  return !drifted;
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const check = process.argv.includes('--check');
  const ok = generateRegistryDocs(check);
  if (!ok) {
    process.exitCode = 1;
  }
}
