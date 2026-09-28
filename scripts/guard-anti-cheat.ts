import fs from 'node:fs';
import path from 'node:path';

/**
 * Automated Anti-Cheating & Integrity Guard
 *
 * Deterministically scans the entire codebase with whole-file multiline analysis to detect:
 * 1. Circular Mocking: Independent test oracles importing production conversion/engine modules.
 * 2. Silent Passes: Tests or oracles bypassing checks with return true / valid: true when CLI tools are missing.
 * 3. Production Hardcoded Cheats: Backdoors (NODE_ENV === 'test'), dummy text placeholders, arbitrary truncations.
 * 4. Hollow Assertions: Meaningless tautological assertions (expect(true).toBe(true), expect("a").toBe("a")).
 */

interface Violation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
  message: string;
}

const violations: Violation[] = [];

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const TESTS_DIR = path.join(ROOT_DIR, 'tests');

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
]);

const SUPPORTED_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function scanDirectory(dir: string, extension: RegExp = SUPPORTED_EXTENSIONS, fileList: string[] = []): string[] {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        scanDirectory(fullPath, extension, fileList);
      }
    } else if (entry.isFile() && extension.test(entry.name)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function getLineAndSnippet(
  content: string,
  index: number,
  matchLength: number = 0
): { line: number; snippet: string } {
  const upToMatch = content.slice(0, index);
  const line = upToMatch.split('\n').length;
  const lineStart = content.lastIndexOf('\n', index) + 1;
  let lineEnd = content.indexOf('\n', index + Math.max(matchLength, 1));
  if (lineEnd === -1) lineEnd = content.length;
  const snippet = content.slice(lineStart, lineEnd).replace(/\s+/g, ' ').trim();
  return {
    line,
    snippet: snippet.length > 120 ? snippet.slice(0, 117) + '...' : snippet,
  };
}

// ============================================================================
// Gate 1: Circular Mocking in Test Helpers / Independent Oracles
// ============================================================================
function checkCircularMocking() {
  const scanDirs = [
    path.join(TESTS_DIR, 'helpers'),
    path.join(ROOT_DIR, 'scripts'),
  ];
  const oracleFiles = scanDirs
    .flatMap((dir) => scanDirectory(dir, SUPPORTED_EXTENSIONS))
    .filter((f) => !f.endsWith('guard-anti-cheat.ts'));

  // Catch path aliases, relative paths, require, and dynamic import
  const circularPatterns = [
    {
      regex: /(?:import\s+[\s\S]*?\s+from|require\s*\(|import\s*\()\s*['"](@\/lib\/conversions|@\/worker\/engines|\.\.?\/[^'"]*(?:\/conversions|\/engines))(?:\/[^'"]*)?['"]/gs,
      desc: 'Oracle, test helper, or corpus script directly imports production conversion/engine modules. Oracles and corpus generation must be independent.',
    },
  ];

  for (const file of oracleFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const pattern of circularPatterns) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(ROOT_DIR, file),
          line,
          rule: 'ANTI-CIRCULAR-MOCKING',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }
}

// ============================================================================
// Gate 2: Silent Pass & Tool Absence Bypasses in Tests
// ============================================================================
function checkSilentPassBypasses() {
  const testFiles = scanDirectory(TESTS_DIR, SUPPORTED_EXTENSIONS);
  const bypassPatterns = [
    {
      // Missing tool variable check returning true or { valid: true } across multiline blocks
      regex: /if\s*\(\s*!(?:toolPath|tool|binPath|binary|executable|ffmpeg|ffprobe|soffice|tesseract|sox|hasTool|isAvailable)\b[\s\S]{0,80}?\)\s*(?:\{\s*return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?\s*\}|return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?)/gis,
      desc: 'Bypassing verification with "return true" or "valid: true" when tool is missing. Use test.skip() or fail closed.',
    },
    {
      // Missing tool function call check returning true or { valid: true }
      regex: /if\s*\(\s*(?:!isOracleToolAvailable\s*\([^)]*\)|isOracleToolAvailable\s*\([^)]*\)\s*===?\s*false|!getOracleToolPath\s*\([^)]*\)|getOracleToolPath\s*\([^)]*\)\s*===?\s*null)[\s\S]{0,80}?\)\s*(?:\{\s*return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?\s*\}|return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?)/gis,
      desc: 'Bypassing verification with "return true" or "valid: true" on oracle tool check. Use test.skip() or fail closed.',
    },
    {
      // catch block silently returning true or { valid: true }
      regex: /catch\s*(?:\([^)]*\))?\s*\{[\s\S]{0,60}?return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\})\s*;?[\s\S]{0,20}?\}/gis,
      desc: 'Catching error and silently returning true or valid: true.',
    },
  ];

  for (const file of testFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const pattern of bypassPatterns) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(ROOT_DIR, file),
          line,
          rule: 'ANTI-SILENT-PASS',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }
}

// ============================================================================
// Gate 3: Production Code Hardcoded Cheats & Backdoors
// ============================================================================
function checkProductionCheats() {
  const srcFiles = scanDirectory(SRC_DIR, SUPPORTED_EXTENSIONS);
  const cheatPatterns = [
    {
      regex: /\[(?:Text|Dummy|Placeholder|Extracted)\s*(?:content|chars)?\s*:\s*\$\{/gis,
      desc: 'Dummy "[Text: N chars]" string placeholder detected in production conversion code.',
    },
    {
      // Frame cap truncation with arbitrary parameter ordering and whitespace
      regex: /Math\.min\s*\(\s*(?:60\s*,\s*totalFrames|totalFrames\s*,\s*60)\s*\)/gis,
      desc: 'Hardcoded audio frame truncation (1.39s cap) detected.',
    },
    {
      // Audio truncation with parameter permutation and whitespace
      regex: /Math\.min\s*\(\s*(?:samples\.length\s*,\s*(?:sampleRate\s*\*\s*channels|channels\s*\*\s*sampleRate)\s*\*\s*60|(?:sampleRate\s*\*\s*channels|channels\s*\*\s*sampleRate)\s*\*\s*60\s*,\s*samples\.length)\s*\)/gis,
      desc: 'Hardcoded audio truncation (60s cap) detected.',
    },
    {
      regex: /['"`]Optical character recognition completed with default fallback/gis,
      desc: 'Dummy OCR default fallback string detected. Fail-closed error must be thrown.',
    },
    {
      // Test backdoor flag in production code
      regex: /process\.env\.NODE_ENV\s*===?\s*['"]test['"]/gs,
      desc: 'Test-specific backdoor branching (process.env.NODE_ENV === "test") detected in production bundle.',
    },
    {
      // Test runner injection flag in production code
      regex: /process\.env\.VITEST\b/gs,
      desc: 'Test-specific runner flag (process.env.VITEST) detected in production bundle.',
    },
  ];

  for (const file of srcFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const pattern of cheatPatterns) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(ROOT_DIR, file),
          line,
          rule: 'ANTI-PRODUCTION-CHEAT',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }
}

// ============================================================================
// Gate 4: Hollow Assertions in Test Suites
// ============================================================================
function checkHollowAssertions() {
  const testFiles = scanDirectory(TESTS_DIR, SUPPORTED_EXTENSIONS);
  const hollowPatterns = [
    {
      // Boolean, numeric, and identifier tautologies: expect(true).toBe(true), expect(123).toBe(123), expect(x).toBe(x)
      regex: /expect\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*|\d+)\s*\)[\s\S]{0,40}?\.(?:toBe|toEqual)\s*\(\s*\1\s*\)/gis,
      desc: 'Hollow assertion tautology detected (e.g., expect(x).toBe(x) or expect(1).toBe(1)).',
    },
    {
      // Literal string tautologies: expect("a").toBe("a")
      regex: /expect\s*\(\s*(['"][^'"]*['"])\s*\)[\s\S]{0,40}?\.(?:toBe|toEqual)\s*\(\s*\1\s*\)/gis,
      desc: 'Hollow assertion tautology with identical string literals detected.',
    },
    {
      // Redundant boolean truthy/falsy assertions
      regex: /expect\s*\(\s*true\s*\)[\s\S]{0,40}?\.toBeTruthy\s*\(\s*\)/gis,
      desc: 'Hollow assertion expect(true).toBeTruthy() detected.',
    },
    {
      regex: /expect\s*\(\s*false\s*\)[\s\S]{0,40}?\.toBeFalsy\s*\(\s*\)/gis,
      desc: 'Hollow assertion expect(false).toBeFalsy() detected.',
    },
    {
      // Literal null/undefined/NaN tautologies
      regex: /expect\s*\(\s*(undefined\s*\)[\s\S]{0,40}?\.toBeUndefined|null\s*\)[\s\S]{0,40}?\.toBeNull|NaN\s*\)[\s\S]{0,40}?\.toBeNaN)/gis,
      desc: 'Hollow assertion on constant literal value detected (e.g., expect(null).toBeNull()).',
    },
  ];

  for (const file of testFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const pattern of hollowPatterns) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(ROOT_DIR, file),
          line,
          rule: 'ANTI-HOLLOW-ASSERTION',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }
}

// ============================================================================
// Main Execution
// ============================================================================
console.log('\n🔒 Running EasyConvert Anti-Cheating & Integrity Guard...\n');

checkCircularMocking();
checkSilentPassBypasses();
checkProductionCheats();
checkHollowAssertions();

if (violations.length > 0) {
  console.error(`\x1b[31m❌ [REJECTED] Found ${violations.length} Anti-Cheating & Test Integrity violation(s):\x1b[0m\n`);
  for (const v of violations) {
    console.error(`  \x1b[33m${v.file}:${v.line}\x1b[0m [\x1b[31m${v.rule}\x1b[0m]`);
    console.error(`    Snippet : "${v.snippet}"`);
    console.error(`    Reason  : ${v.message}\n`);
  }
  console.error('\x1b[31mIntegrity check FAILED. Please resolve all violations according to AGENTS.md.\x1b[0m\n');
  process.exit(1);
} else {
  console.log('\x1b[32m✅ [PASS] Zero shortcuts, zero circular mocks, zero silent passes, zero hollow assertions detected.\x1b[0m\n');
  process.exit(0);
}
