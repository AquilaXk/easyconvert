import fs from 'node:fs';
import path from 'node:path';

/**
 * Automated Anti-Cheating & Integrity Guard
 *
 * Deterministically scans the entire codebase to detect and reject:
 * 1. Circular Mocking: Test oracles importing production conversion modules.
 * 2. Silent Passes: Tests or oracles returning true / passing when CLI tools are absent.
 * 3. Production Hardcoded Cheats: Dummy text strings, fake confidence, arbitrary truncations.
 * 4. Hollow Assertions: Meaningless assertions like expect(true).toBe(true).
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

function scanDirectory(dir: string, extension: RegExp, fileList: string[] = []): string[] {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.next' && entry.name !== '.git') {
        scanDirectory(fullPath, extension, fileList);
      }
    } else if (entry.isFile() && extension.test(entry.name)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// ============================================================================
// Gate 1: Circular Mocking in Test Helpers / Oracles
// ============================================================================
function checkCircularMocking() {
  const helperFiles = scanDirectory(path.join(TESTS_DIR, 'helpers'), /\.(ts|js)$/)
    .filter((f) => !f.endsWith('corpus-synthesizer.ts') && !f.endsWith('golden-corpus-suite.ts'));
  const circularImportPattern = /from\s+['"][^'"]*\/src\/lib\/conversions\/[^'"]*['"]/;

  for (const file of helperFiles) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, idx) => {
      if (circularImportPattern.test(line)) {
        violations.push({
          file: path.relative(ROOT_DIR, file),
          line: idx + 1,
          rule: 'ANTI-CIRCULAR-MOCKING',
          snippet: line.trim(),
          message: 'Oracle or test helper directly imports production conversion modules. Oracles must be independent.',
        });
      }
    });
  }
}

// ============================================================================
// Gate 2: Silent Pass & Tool Absence Bypasses in Tests
// ============================================================================
function checkSilentPassBypasses() {
  const testFiles = scanDirectory(TESTS_DIR, /\.(ts|js)$/);
  const bypassPatterns = [
    {
      regex: /if\s*\(!toolPath\)\s*return\s+true/i,
      desc: 'Bypassing verification with "return true" when tool is missing.',
    },
    {
      regex: /if\s*\(!tool\)\s*return\s+true/i,
      desc: 'Bypassing verification with "return true" when tool is missing.',
    },
    {
      regex: /if\s*\(!toolPath\)\s*return\s*\{[^}]*valid:\s*true/i,
      desc: 'Bypassing verification with "valid: true" when tool is missing.',
    },
    {
      regex: /catch\s*(?:\([^)]*\))?\s*\{\s*return\s+true\s*;\s*\}/i,
      desc: 'Catching error and silently returning true.',
    },
  ];

  for (const file of testFiles) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, idx) => {
      for (const pattern of bypassPatterns) {
        if (pattern.regex.test(line)) {
          violations.push({
            file: path.relative(ROOT_DIR, file),
            line: idx + 1,
            rule: 'ANTI-SILENT-PASS',
            snippet: line.trim(),
            message: pattern.desc,
          });
        }
      }
    });
  }
}

// ============================================================================
// Gate 3: Production Code Hardcoded Cheats & Fallbacks
// ============================================================================
function checkProductionCheats() {
  const srcFiles = scanDirectory(SRC_DIR, /\.(ts|tsx)$/);
  const cheatPatterns = [
    {
      regex: /\[Text:\s*\$\{/i,
      desc: 'Dummy "[Text: N chars]" string placeholder detected in production conversion code.',
    },
    {
      regex: /Math\.min\(\s*60\s*,\s*totalFrames\s*\)/i,
      desc: 'Hardcoded audio frame truncation (1.39s cap) detected.',
    },
    {
      regex: /Math\.min\(\s*samples\.length\s*,\s*sampleRate\s*\*\s*channels\s*\*\s*60\s*\)/i,
      desc: 'Hardcoded audio truncation (60s cap) detected.',
    },
    {
      regex: /['"`]Optical character recognition completed with default fallback/i,
      desc: 'Dummy OCR default fallback string detected. Fail-closed error must be thrown.',
    },
  ];

  for (const file of srcFiles) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, idx) => {
      for (const pattern of cheatPatterns) {
        if (pattern.regex.test(line)) {
          violations.push({
            file: path.relative(ROOT_DIR, file),
            line: idx + 1,
            rule: 'ANTI-PRODUCTION-CHEAT',
            snippet: line.trim(),
            message: pattern.desc,
          });
        }
      }
    });
  }
}

// ============================================================================
// Gate 4: Hollow Assertions in Test Suites
// ============================================================================
function checkHollowAssertions() {
  const testFiles = scanDirectory(TESTS_DIR, /\.(ts|js)$/);
  const hollowPatterns = [
    {
      regex: /expect\(\s*true\s*\)\.toBe\(\s*true\s*\)/i,
      desc: 'Hollow assertion expect(true).toBe(true) detected.',
    },
    {
      regex: /expect\(\s*1\s*\)\.toBe\(\s*1\s*\)/i,
      desc: 'Hollow assertion expect(1).toBe(1) detected.',
    },
  ];

  for (const file of testFiles) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, idx) => {
      for (const pattern of hollowPatterns) {
        if (pattern.regex.test(line)) {
          violations.push({
            file: path.relative(ROOT_DIR, file),
            line: idx + 1,
            rule: 'ANTI-HOLLOW-ASSERTION',
            snippet: line.trim(),
            message: pattern.desc,
          });
        }
      }
    });
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
