import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

/**
 * Automated Anti-Cheating & Integrity Guard
 *
 * Deterministically scans the codebase using whole-file regex and TypeScript AST analysis:
 * 1. Circular Mocking (G1, G1b): Independent test oracles importing production modules or self-validating inverse pairs.
 * 2. Silent Passes & Positive Guards (G2, G2b): Bypasses on missing CLI tools or positive guards skipping verifications.
 * 3. Production Hardcoded Cheats (G3, G3b, G3c): Dummy string placeholders, fixed truncations, and unreferenced inputs.
 * 4. Hollow & Weak Assertions (G4, G4b, G4c): Tautologies, tests composed exclusively of weak assertions, and
 *    `toBeDefined()` on lookups that return `null` (not `undefined`) when the entry is missing.
 * 5. Governance (G5, G6): Automation reaching external hosts and built-in imports without the node: prefix.
 * 6. Ratchet Baseline: Baseline violation tracking with strict ratcheting down.
 */

export interface Violation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
  message: string;
  symbol?: string;
  severity?: 'error' | 'warning';
}

export interface BaselineEntry {
  rule: string;
  file: string;
  symbol?: string;
  reason: string;
  owningWP: string;
}

const ROOT_DIR = process.env.GUARD_ROOT ? path.resolve(process.env.GUARD_ROOT) : path.resolve(__dirname, '..');
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
  '.worktrees',
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

function getNodeSnippet(sourceFile: ts.SourceFile, node: ts.Node): { line: number; snippet: string } {
  const start = node.getStart(sourceFile);
  const { line } = sourceFile.getLineAndCharacterOfPosition(start);
  const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
  return {
    line: line + 1,
    snippet: text.length > 120 ? text.slice(0, 117) + '...' : text,
  };
}

// ============================================================================
// Gate 1: Circular Mocking (Regex G1 + AST G1b)
// ============================================================================
function checkCircularMocking(targetDir?: string): Violation[] {
  const violations: Violation[] = [];
  const scanDirs = targetDir
    ? [targetDir]
    : [path.join(TESTS_DIR, 'helpers'), path.join(ROOT_DIR, 'scripts')];
  const oracleFiles = scanDirs
    .flatMap((dir) => scanDirectory(dir, SUPPORTED_EXTENSIONS))
    .filter((f) => !f.endsWith('guard-anti-cheat.ts') && !f.endsWith('guard-anti-cheat-rules.test.ts'));

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

  // G1b AST: Circular mocking warning in tests (inverse pairs feeding into each other)
  const testFiles = scanDirectory(targetDir || TESTS_DIR, SUPPORTED_EXTENSIONS)
    .filter((f) => !f.endsWith('guard-anti-cheat-rules.test.ts'));

  for (const file of testFiles) {
    const code = fs.readFileSync(file, 'utf-8');
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);

    function checkG1b(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const fnName = node.expression.getText(sf);
        if (['it', 'test', 'oracleTest'].includes(fnName)) {
          let testTitle = 'unknown';
          if (node.arguments.length > 0 && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
            testTitle = node.arguments[0].text;
          }

          // Look for inverse pairs: encodeX / parseX, createX / extractX, compressX / decompressX
          const callsInTest: string[] = [];
          function collectCalls(n: ts.Node) {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
              callsInTest.push(n.expression.text);
            }
            ts.forEachChild(n, collectCalls);
          }
          ts.forEachChild(node, collectCalls);

          const hasEncode = callsInTest.some((c) => /^encode[A-Z0-9]/.test(c));
          const hasParse = callsInTest.some((c) => /^(?:parse|decode)[A-Z0-9]/.test(c));
          const hasCompress = callsInTest.some((c) => /^compress[A-Z0-9]/.test(c));
          const hasDecompress = callsInTest.some((c) => /^decompress[A-Z0-9]/.test(c));

          if ((hasEncode && hasParse) || (hasCompress && hasDecompress)) {
            // Check if test has external oracle verification
            const hasOracle = callsInTest.some((c) => /^(?:verify|assert)[A-Z0-9]/.test(c) || c.includes('Oracle'));
            if (!hasOracle) {
              const { line, snippet } = getNodeSnippet(sf, node);
              violations.push({
                file: path.relative(ROOT_DIR, file),
                line,
                rule: 'G1b-CIRCULAR-MOCKING-WARNING',
                symbol: testTitle,
                snippet,
                message: `Test "${testTitle}" calls reciprocal production functions without an independent differential oracle verification.`,
                severity: 'warning',
              });
            }
          }
        }
      }
      ts.forEachChild(node, checkG1b);
    }
    checkG1b(sf);
  }

  return violations;
}

// ============================================================================
// Gate 2: Silent Pass & Positive Guards (Regex G2 + AST G2b)
// ============================================================================
function checkSilentPassBypasses(targetDir?: string): Violation[] {
  const violations: Violation[] = [];
  const testFiles = scanDirectory(targetDir || TESTS_DIR, SUPPORTED_EXTENSIONS)
    .filter((f) => !f.endsWith('guard-anti-cheat-rules.test.ts'));

  const bypassPatterns = [
    {
      regex: /if\s*\(\s*!(?:toolPath|tool|binPath|binary|executable|ffmpeg|ffprobe|soffice|tesseract|sox|hasTool|isAvailable)\b[\s\S]{0,80}?\)\s*(?:\{\s*return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?\s*\}|return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?)/gis,
      desc: 'Bypassing verification with "return true" or "valid: true" when tool is missing. Use test.skip() or fail closed.',
    },
    {
      regex: /if\s*\(\s*(?:!isOracleToolAvailable\s*\([^)]*\)|isOracleToolAvailable\s*\([^)]*\)\s*===?\s*false|!getOracleToolPath\s*\([^)]*\)|getOracleToolPath\s*\([^)]*\)\s*===?\s*null)[\s\S]{0,80}?\)\s*(?:\{\s*return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?\s*\}|return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?)/gis,
      desc: 'Bypassing verification with "return true" or "valid: true" on oracle tool check. Use test.skip() or fail closed.',
    },
    {
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

    // G2b AST: Positive-guard skip in tests
    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

    function checkG2b(node: ts.Node) {
      if (ts.isIfStatement(node) && node.elseStatement === undefined) {
        let isPositiveToolGuard = false;

        function inspectCondition(condNode: ts.Node, isNegated: boolean = false) {
          if (ts.isPrefixUnaryExpression(condNode) && condNode.operator === ts.SyntaxKind.ExclamationToken) {
            inspectCondition(condNode.operand, !isNegated);
            return;
          }
          if (ts.isCallExpression(condNode)) {
            const callee = condNode.expression.getText(sf);
            if (callee === 'isOracleToolAvailable' || callee === 'getOracleToolPath' || callee.endsWith('BinaryPath')) {
              if (!isNegated) isPositiveToolGuard = true;
            }
          } else if (ts.isIdentifier(condNode)) {
            const name = condNode.text;
            if ((name.endsWith('Path') || name === 'hasTool' || name === 'isAvailable') && !isNegated) {
              // Ensure it's not a parameter or local variable in non-tool context
              if (name !== 'targetPath' && name !== 'filePath' && name !== 'outputPath' && name !== 'inputPath') {
                isPositiveToolGuard = true;
              }
            }
          } else if (ts.isBinaryExpression(condNode)) {
            inspectCondition(condNode.left, isNegated);
            inspectCondition(condNode.right, isNegated);
          }
        }

        inspectCondition(node.expression);

        if (isPositiveToolGuard) {
          let hasAssertionOrVerification = false;
          function inspectThen(thenNode: ts.Node) {
            if (ts.isCallExpression(thenNode)) {
              const callee = thenNode.expression.getText(sf);
              if (
                callee === 'expect' ||
                /^(?:verify|check|assert)[A-Z0-9_]/.test(callee) ||
                callee.includes('runDifferentialComparison')
              ) {
                hasAssertionOrVerification = true;
              }
            }
            ts.forEachChild(thenNode, inspectThen);
          }
          inspectThen(node.thenStatement);

          if (hasAssertionOrVerification) {
            const { line, snippet } = getNodeSnippet(sf, node);
            violations.push({
              file: path.relative(ROOT_DIR, file),
              line,
              rule: 'G2b-POSITIVE-GUARD-SKIP',
              snippet,
              message:
                'Positive-guard skip detected: positive tool check without else wraps assertions or verifications. Use oracleTest or ctx.skip() instead.',
            });
          }
        }
      }
      ts.forEachChild(node, checkG2b);
    }
    checkG2b(sf);
  }

  return violations;
}

// ============================================================================
// Gate 3: Production Code Cheats (Regex G3 + AST G3b + AST G3c)
// ============================================================================
function checkProductionCheats(targetDir?: string): Violation[] {
  const violations: Violation[] = [];
  const srcFiles = scanDirectory(targetDir || SRC_DIR, SUPPORTED_EXTENSIONS);
  const cheatPatterns = [
    {
      regex: /\[(?:Text|Dummy|Placeholder|Extracted)\s*(?:content|chars)?\s*:\s*\$\{/gis,
      desc: 'Dummy "[Text: N chars]" string placeholder detected in production conversion code.',
    },
    {
      regex: /Math\.min\s*\(\s*(?:60\s*,\s*totalFrames|totalFrames\s*,\s*60)\s*\)/gis,
      desc: 'Hardcoded audio frame truncation (1.39s cap) detected.',
    },
    {
      regex: /Math\.min\s*\(\s*(?:samples\.length\s*,\s*(?:sampleRate\s*\*\s*channels|channels\s*\*\s*sampleRate)\s*\*\s*60|(?:sampleRate\s*\*\s*channels|channels\s*\*\s*sampleRate)\s*\*\s*60\s*,\s*samples\.length)\s*\)/gis,
      desc: 'Hardcoded audio truncation (60s cap) detected.',
    },
    {
      regex: /['"`]Optical character recognition completed with default fallback/gis,
      desc: 'Dummy OCR default fallback string detected. Fail-closed error must be thrown.',
    },
    {
      regex: /process\.env\.NODE_ENV\s*===?\s*['"]test['"]/gs,
      desc: 'Test-specific backdoor branching (process.env.NODE_ENV === "test") detected in production bundle.',
    },
    {
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

    // AST checks for G3b (Truncation) and G3c (Ignored input) in conversions and worker
    const rel = path.relative(ROOT_DIR, file);
    const isTargetModule = rel.includes('src/lib/conversions') || rel.includes('src/worker') || (targetDir && !rel.startsWith('tests'));

    if (isTargetModule) {
      const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

      function checkFnAST(name: string, isExported: boolean, params: ts.NodeArray<ts.ParameterDeclaration>, body: ts.Node) {
        if (!/^(?:encode|write|create|serialize)/i.test(name)) return;

        // G3b Truncation check
        function findTruncation(n: ts.Node) {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            const prop = n.expression.name.text;
            if (prop === 'slice' || prop === 'subarray') {
              if (n.arguments.length >= 2) {
                const arg0 = n.arguments[0];
                const arg1 = n.arguments[1];
                if (ts.isNumericLiteral(arg0) && arg0.text === '0' && ts.isNumericLiteral(arg1)) {
                  const { line, snippet } = getNodeSnippet(sf, n);
                  violations.push({
                    file: path.relative(ROOT_DIR, file),
                    line,
                    rule: 'G3b-TRUNCATION',
                    symbol: name,
                    snippet,
                    message: `Hardcoded numeric truncation "${n.getText(sf)}" inside generator/converter function "${name}".`,
                  });
                }
              }
            }
          }
          ts.forEachChild(n, findTruncation);
        }
        findTruncation(body);

        // G3c Ignored input check (exported generator function)
        if (isExported && params.length >= 1) {
          const p0 = params[0];
          if (ts.isIdentifier(p0.name)) {
            const paramName = p0.name.text;
            let refCount = 0;

            function countRefs(n: ts.Node) {
              if (ts.isIdentifier(n) && n.text === paramName && n !== p0.name) {
                // Ensure it is not a property name in obj.prop
                if (!(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
                  // Ensure it is not an object literal key
                  if (!(n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
                    refCount++;
                  }
                }
              }
              ts.forEachChild(n, countRefs);
            }
            countRefs(body);

            if (refCount === 0) {
              const { line, snippet } = getNodeSnippet(sf, p0);
              violations.push({
                file: path.relative(ROOT_DIR, file),
                line,
                rule: 'G3c-IGNORED-INPUT',
                symbol: name,
                snippet,
                message: `Exported function "${name}" ignores its first parameter "${paramName}" entirely.`,
              });
            }
          }
        }
      }

      function inspectAST(n: ts.Node) {
        if (ts.isFunctionDeclaration(n) && n.name && n.body) {
          const isExported = Boolean(n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
          checkFnAST(n.name.text, isExported, n.parameters, n.body);
        } else if (ts.isVariableStatement(n)) {
          const isExported = Boolean(n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
          for (const decl of n.declarationList.declarations) {
            if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
              if (ts.isIdentifier(decl.name) && decl.initializer.body) {
                checkFnAST(decl.name.text, isExported, decl.initializer.parameters, decl.initializer.body);
              }
            }
          }
        }
        ts.forEachChild(n, inspectAST);
      }
      inspectAST(sf);
    }
  }

  return violations;
}

// ============================================================================
// Gate 4: Hollow Assertions & Weak-Only Assertions (Regex G4 + AST G4b)
// ============================================================================
function checkHollowAssertions(targetDir?: string): Violation[] {
  const violations: Violation[] = [];
  const testFiles = scanDirectory(targetDir || TESTS_DIR, SUPPORTED_EXTENSIONS)
    .filter((f) => !f.endsWith('guard-anti-cheat-rules.test.ts'));

  const hollowPatterns = [
    {
      regex: /expect\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*|\d+)\s*\)[\s\S]{0,40}?\.(?:toBe|toEqual)\s*\(\s*\1\s*\)/gis,
      desc: 'Hollow assertion tautology detected (e.g., expect(x).toBe(x) or expect(1).toBe(1)).',
    },
    {
      regex: /expect\s*\(\s*(['"][^'"]*['"])\s*\)[\s\S]{0,40}?\.(?:toBe|toEqual)\s*\(\s*\1\s*\)/gis,
      desc: 'Hollow assertion tautology with identical string literals detected.',
    },
    {
      regex: /expect\s*\(\s*true\s*\)[\s\S]{0,40}?\.toBeTruthy\s*\(\s*\)/gis,
      desc: 'Hollow assertion expect(true).toBeTruthy() detected.',
    },
    {
      regex: /expect\s*\(\s*false\s*\)[\s\S]{0,40}?\.toBeFalsy\s*\(\s*\)/gis,
      desc: 'Hollow assertion expect(false).toBeFalsy() detected.',
    },
    {
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

    // G4b AST: Weak-only assertions in test blocks
    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

    function checkG4b(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const calleeText = node.expression.getText(sf);
        if (
          calleeText === 'it' ||
          calleeText === 'test' ||
          calleeText === 'oracleTest' ||
          calleeText.startsWith('it.') ||
          calleeText.startsWith('test.') ||
          calleeText.startsWith('oracleTest.')
        ) {
          let testTitle = 'unknown';
          if (node.arguments.length > 0 && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
            testTitle = node.arguments[0].text;
          }

          let totalAssertions = 0;
          let weakAssertions = 0;

          function findExpectCalls(n: ts.Node) {
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
              let matcherName = n.expression.name.text;
              let target = n.expression.expression;

              if (ts.isPropertyAccessExpression(target)) {
                // handle .not or .resolves or .rejects
                target = target.expression;
              }

              if (ts.isCallExpression(target) && target.expression.getText(sf) === 'expect') {
                totalAssertions++;
                let isWeak = false;

                if (['toBeDefined', 'toBeTruthy', 'toBeFalsy', 'toBeInstanceOf'].includes(matcherName)) {
                  isWeak = true;
                } else if (matcherName === 'toThrow') {
                  if (n.arguments.length === 0) isWeak = true;
                } else if (matcherName === 'toBeGreaterThan') {
                  if (n.arguments.length === 1 && ts.isNumericLiteral(n.arguments[0]) && n.arguments[0].text === '0') {
                    isWeak = true;
                  }
                } else if (matcherName === 'toContain') {
                  if (
                    n.arguments.length === 1 &&
                    (ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0]))
                  ) {
                    isWeak = true;
                  }
                }

                if (isWeak) weakAssertions++;
              }
            }
            ts.forEachChild(n, findExpectCalls);
          }

          const fnArg = node.arguments.find((a) => ts.isFunctionExpression(a) || ts.isArrowFunction(a));
          if (fnArg) {
            findExpectCalls(fnArg);
            if (totalAssertions > 0 && totalAssertions === weakAssertions) {
              const { line, snippet } = getNodeSnippet(sf, node);
              violations.push({
                file: path.relative(ROOT_DIR, file),
                line,
                rule: 'G4b-WEAK-ONLY-ASSERTIONS',
                symbol: testTitle,
                snippet,
                message: `Test block "${testTitle}" contains only weak assertions (${weakAssertions} weak matcher(s)). Must include at least one substantive check.`,
              });
            }
          }
        }
      }
      ts.forEachChild(node, checkG4b);
    }
    checkG4b(sf);
    violations.push(...checkHollowNullChecks(sf, file));
  }

  return violations;
}

/**
 * G4c: `expect(x).toBeDefined()` where `x` is a lookup that returns `null` when the entry is missing.
 * JSZip's `zip.file(name)` and the Fetch API's `Headers.get(name)` (and `URLSearchParams.get`) answer `null`, not
 * `undefined`, for an absent entry, so `toBeDefined()` passes either way and proves nothing. The subject is either the
 * call itself or an identifier bound by `const x = <such call>` in the same function. Receivers of `.get(` are limited to
 * header and search-parameter objects, because `Map.get` does return `undefined` and `toBeDefined()` is meaningful there.
 */
const NULL_RETURNING_GET_RECEIVER = /(?:^|\.)(?:headers?|searchParams|URLSearchParams)$/i;

function isNullReturningLookup(expr: ts.Expression, sf: ts.SourceFile): boolean {
  let node: ts.Expression = expr;
  while (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  if (method === 'file') return true;
  return method === 'get' && NULL_RETURNING_GET_RECEIVER.test(node.expression.expression.getText(sf).replace(/\s+/g, ''));
}

function findLocalInitializer(identifier: ts.Identifier, sf: ts.SourceFile): ts.Expression | undefined {
  let scope: ts.Node | undefined = identifier.parent;
  while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  let found: ts.Expression | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === identifier.text && n.initializer) {
      found = n.initializer;
    }
    ts.forEachChild(n, visit);
  };
  if (scope) visit(scope);
  void sf;
  return found;
}

function checkHollowNullChecks(sf: ts.SourceFile, file: string): Violation[] {
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'toBeDefined' &&
      ts.isCallExpression(node.expression.expression) &&
      node.expression.expression.expression.getText(sf) === 'expect' &&
      node.expression.expression.arguments.length > 0
    ) {
      const subject = node.expression.expression.arguments[0];
      const resolved = ts.isIdentifier(subject) ? findLocalInitializer(subject, sf) : subject;
      if (resolved && isNullReturningLookup(resolved, sf)) {
        const { line, snippet } = getNodeSnippet(sf, node);
        violations.push({
          file: path.relative(ROOT_DIR, file),
          line,
          rule: 'G4c-HOLLOW-NULL-CHECK',
          snippet,
          message:
            'toBeDefined() on a lookup that returns null (JSZip file(), Headers.get(), URLSearchParams.get()) passes for a missing entry. Assert not.toBeNull() and then the entry content or the exact header value.',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

// ============================================================================
// Gate 5: Governance (AST G5 external navigation + AST G6 built-in specifier)
//
// G5 checks only the URL (or host) position of each API, resolving in-scope `const` bindings through the checker.
// Known limits: values assigned through `let` reassignment, property access (`cfg.url`), imported constants,
// function returns, loops, and object spreads are not resolved, so such URLs are treated as unknown.
// ============================================================================

/** Exact hosts a script or test may reach: loopback, the docker host gateway, and the unspecified address. */
const LOCAL_HOST_NAMES: ReadonlySet<string> = new Set(['localhost', '0.0.0.0', '[::1]', 'host.docker.internal']);
/** The whole 127.0.0.0/8 loopback range. */
const LOOPBACK_IPV4_PATTERN = /^127(\.\d{1,3}){3}$/;
/** RFC 6761 / RFC 2606 reserved names that never resolve to a public site. */
const RESERVED_LOCAL_SUFFIX_PATTERN = /\.(localhost|test|example|invalid)$/i;
const DOCUMENTATION_DOMAIN_PATTERN = /^([a-z0-9-]+\.)*example\.(com|org|net)$/i;
/** A dotless name such as a docker compose service (`redis`, `worker`); IPv4 has dots and IPv6 has brackets. */
const SINGLE_LABEL_HOST_PATTERN = /^[a-z0-9-]+$/i;
/** Calls whose first argument is the URL to load. */
const URL_ARGUMENT_CALLEES: ReadonlySet<string> = new Set(['goto', 'fetch', 'navigate']);
/** Calls whose first argument is an options object that may carry a `baseURL`. */
const BASE_URL_OPTION_CALLEES: ReadonlySet<string> = new Set(['newPage', 'newContext']);
const BASE_URL_PROPERTIES: readonly string[] = ['baseURL'];
/** Properties of a request config object (`axios({ url })`) that name the target. */
const REQUEST_CONFIG_URL_PROPERTIES: readonly string[] = ['url', 'baseURL'];
/** Constructors whose first argument is the URL to open (`new WebSocket(url)`). */
const URL_ARGUMENT_CONSTRUCTORS: ReadonlySet<string> = new Set(['WebSocket', 'EventSource']);
/** `node:http` / `node:https` clients whose first argument is the URL to request. */
const NODE_HTTP_RECEIVERS: ReadonlySet<string> = new Set(['http', 'https']);
const NODE_HTTP_METHODS: ReadonlySet<string> = new Set(['get', 'request']);
const NODE_HTTP_MODULES: ReadonlySet<string> = new Set(['http', 'https', 'node:http', 'node:https']);
/** Properties of a `node:http(s)` options object that name the target host (not a URL). */
const NODE_HTTP_HOST_PROPERTIES: readonly string[] = ['hostname', 'host'];
/** Receivers whose `use(options)` sets test-wide options that may carry a `baseURL`. */
const TEST_OPTION_RECEIVERS: ReadonlySet<string> = new Set(['test']);
const TEST_OPTION_METHOD = 'use';
const AXIOS_RECEIVER = 'axios';
const AXIOS_CREATE_METHOD = 'create';
/** Index of the config argument of axios verb helpers: `get(url, config)`, `post(url, data, config)`. */
const AXIOS_CONFIG_ARGUMENT_INDEX: ReadonlyMap<string, number> = new Map([
  ['get', 1],
  ['delete', 1],
  ['head', 1],
  ['options', 1],
  ['post', 2],
  ['put', 2],
  ['patch', 2],
]);
/** Receivers whose HTTP-verb methods issue a request (`page.request.get`, `request.post`, `axios.get`). */
const REQUEST_RECEIVERS: ReadonlySet<string> = new Set(['request', 'axios']);
const REQUEST_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'fetch', 'request']);
/** Scheme of an http(s) or ws(s) URL, captured without the slashes the URL parser also accepts as optional. */
const HTTP_SCHEME_PREFIX = /^((?:http|ws)s?:)[/\\]*/i;
/** Characters that end the authority (`userinfo@host:port`) of a URL. */
const AUTHORITY_TERMINATOR = /[/?#]/;
/** A URL input that carries its own scheme and therefore ignores the base passed to `new URL`. */
const ABSOLUTE_URL_INPUT = /^[a-z][a-z0-9+.-]*:/i;
/** Reported host when a URL reaches a host that cannot be known statically but might be external. */
const UNKNOWN_HOST = '<unknown host>';
/** Bound on chained constant lookups (`const A = B; const B = ...`) so cyclic references terminate. */
const MAX_CONSTANT_RESOLUTION_DEPTH = 16;
const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules.filter((m) => !m.startsWith('_')));

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
}

/**
 * Statically known chunks of a string expression with an unknown value between each pair.
 * A single chunk means the whole value is known; `['', '']` means nothing is known.
 */
interface StaticText {
  parts: string[];
}

const UNKNOWN_TEXT: StaticText = { parts: ['', ''] };

function knownText(text: string): StaticText {
  return { parts: [text] };
}

function concatStatic(left: StaticText, right: StaticText): StaticText {
  const head = left.parts.slice(0, -1);
  const joint = left.parts[left.parts.length - 1] + right.parts[0];
  return { parts: [...head, joint, ...right.parts.slice(1)] };
}

/** Scope-aware resolver: the checker binds each identifier to the declaration actually in scope. */
interface ConstantResolver {
  checker?: ts.TypeChecker;
  depth: number;
}

function deeper(resolver: ConstantResolver): ConstantResolver {
  return { checker: resolver.checker, depth: resolver.depth + 1 };
}

/** Strips parentheses and type-only wrappers (`as const`, `satisfies`, `<T>`, `!`). */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Initializer of the in-scope `const` an identifier refers to; undefined for parameters, `let`, imports, or shadowed names. */
function constInitializer(identifier: ts.Identifier, resolver: ConstantResolver): ts.Expression | undefined {
  const { checker } = resolver;
  if (!checker || resolver.depth > MAX_CONSTANT_RESOLUTION_DEPTH) return undefined;
  const parent = identifier.parent;
  const symbol =
    parent && ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return undefined;
  if (!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) return undefined;
  return declaration.initializer;
}

function staticText(node: ts.Expression, resolver: ConstantResolver): StaticText {
  const expr = unwrapExpression(node);
  const literal = stringLiteralText(expr);
  if (literal !== undefined) return knownText(literal);
  if (ts.isIdentifier(expr)) {
    const initializer = constInitializer(expr, resolver);
    return initializer ? staticText(initializer, deeper(resolver)) : UNKNOWN_TEXT;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return concatStatic(staticText(expr.left, resolver), staticText(expr.right, resolver));
  }
  if (ts.isTaggedTemplateExpression(expr)) return staticText(expr.template, resolver);
  if (ts.isTemplateExpression(expr)) {
    let acc = knownText(expr.head.text);
    for (const span of expr.templateSpans) {
      acc = concatStatic(concatStatic(acc, staticText(span.expression, resolver)), knownText(span.literal.text));
    }
    return acc;
  }
  if (ts.isNewExpression(expr)) return newExpressionText(expr, resolver);
  return UNKNOWN_TEXT;
}

/** Text of `new URL(...)` or of the URL wrapped by `new Request(url, init)`. */
function newExpressionText(node: ts.NewExpression, resolver: ConstantResolver): StaticText {
  const [input] = node.arguments ?? [];
  if (input && ts.isIdentifier(node.expression) && node.expression.text === 'Request') return staticText(input, resolver);
  return urlConstructorText(node, resolver);
}

/** `new URL(input, base)`: the resolved href, or the base origin when the relative input is unknown. */
function urlConstructorText(node: ts.NewExpression, resolver: ConstantResolver): StaticText {
  const args = node.arguments ?? [];
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'URL' || args.length === 0) return UNKNOWN_TEXT;
  const input = staticText(args[0], resolver);
  if (args.length === 1 || ABSOLUTE_URL_INPUT.test(input.parts[0])) return input;
  const base = staticText(args[1], resolver);
  if (input.parts.length === 1 && base.parts.length === 1) {
    try {
      return knownText(new URL(input.parts[0], base.parts[0]).href);
    } catch {
      return UNKNOWN_TEXT;
    }
  }
  const scheme = HTTP_SCHEME_PREFIX.exec(base.parts[0]);
  const host = externalUrlHost(base);
  if (!scheme || !host) return UNKNOWN_TEXT;
  return concatStatic(knownText(`${scheme[1]}//${host}/`), UNKNOWN_TEXT);
}

/**
 * Host of an http(s) URL whose host part is statically known, or undefined when it is not a URL or the host is unknown.
 * The authority of a partially known URL is only trusted when the host follows the last unknown chunk inside it after a
 * literal `@`, or when the authority is fully known: an unknown chunk could otherwise still hold `user:pass@other-host`.
 */
function externalUrlHost(value: StaticText): string | undefined {
  const scheme = HTTP_SCHEME_PREFIX.exec(value.parts[0]);
  if (!scheme) return undefined;
  if (value.parts.length === 1) {
    try {
      return new URL(value.parts[0]).hostname;
    } catch {
      // A complete literal that fails to parse is still an attempt to reach a site: fail closed.
      return '';
    }
  }
  const authority: string[] = [];
  const chunks = [value.parts[0].slice(scheme[0].length), ...value.parts.slice(1)];
  for (const chunk of chunks) {
    const end = chunk.search(AUTHORITY_TERMINATOR);
    authority.push(end === -1 ? chunk : chunk.slice(0, end));
    if (end !== -1) break;
  }
  const lastChunk = authority[authority.length - 1];
  const at = lastChunk.lastIndexOf('@');
  if (authority.length === 1 || at !== -1) return parseHost(scheme[1], lastChunk.slice(at + 1));
  return externalSuffixHost(scheme[1], lastChunk) ?? hostBeforeUnknownAuthority(scheme[1], authority);
}

/** Placeholder label standing in for an unknown subdomain when checking a fixed host suffix. */
const SUBDOMAIN_PLACEHOLDER = 'subdomain';

/**
 * `https://${sub}.third-party.dev/x`: the fixed suffix after the last unknown value is already a registrable host
 * (two or more labels), so any subdomain of it is reported as `*.<suffix>`. A local suffix resolves as local.
 */
function externalSuffixHost(scheme: string, lastChunk: string): string | undefined {
  if (!lastChunk.startsWith('.')) return undefined;
  const host = parseHost(scheme, SUBDOMAIN_PLACEHOLDER + lastChunk);
  if (host === undefined) return undefined;
  if (isReservedLocalHost(host)) return host;
  const suffix = host.slice(SUBDOMAIN_PLACEHOLDER.length + 1);
  return suffix.includes('.') ? `*.${suffix}` : undefined;
}

function parseHost(scheme: string, hostPort: string): string | undefined {
  if (!hostPort) return undefined;
  try {
    return new URL(`${scheme}//${hostPort}/`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Host of an authority that continues into an unknown value with no literal `@` after it.
 * - With a `:`: the literal text before it is the host, unless it is a single label that may be a username
 *   (`api:${key}`) or a literal `@` later hands the host to an unknown value; then the host is unknown.
 * - Without a `:` (`https://third-party.dev${path}`): the literal text is the host when it is local or already
 *   dotted; a bare label that the unknown value may extend is an unknown host.
 * - With no literal host at all (`https://${host}`) nothing is known and nothing is reported.
 * Unknown hosts are reported conservatively as UNKNOWN_HOST.
 */
function hostBeforeUnknownAuthority(scheme: string, authority: string[]): string | undefined {
  const [first, ...rest] = authority;
  const hostSection = first.slice(first.lastIndexOf('@') + 1);
  const colon = hostSection.indexOf(':');
  const literalHost = colon === -1 ? hostSection : hostSection.slice(0, colon);
  if (!literalHost) return undefined;
  if (colon !== -1 && rest.some((chunk) => chunk.includes('@'))) return UNKNOWN_HOST;
  const host = parseHost(scheme, literalHost);
  if (host === undefined) return undefined;
  if (isReservedLocalHost(host)) return host;
  if (colon === -1) return host.includes('.') ? host : UNKNOWN_HOST;
  const mayBeUsername = !first.includes('@') && SINGLE_LABEL_HOST_PATTERN.test(host);
  return mayBeUsername ? UNKNOWN_HOST : host;
}

/** Host named by a `node:http(s)` `hostname` / `host` option; only a fully known value is checked. */
function optionHost(value: StaticText): string | undefined {
  if (value.parts.length !== 1 || !value.parts[0]) return undefined;
  return parseHost('http:', value.parts[0]) ?? '';
}

/** Loopback, docker gateway, and reserved names; excludes bare single labels, which may also be usernames. */
function isReservedLocalHost(host: string): boolean {
  const name = host.toLowerCase();
  return (
    LOCAL_HOST_NAMES.has(name) ||
    LOOPBACK_IPV4_PATTERN.test(name) ||
    RESERVED_LOCAL_SUFFIX_PATTERN.test(name) ||
    DOCUMENTATION_DOMAIN_PATTERN.test(name)
  );
}

function isLocalHost(host: string): boolean {
  return isReservedLocalHost(host) || SINGLE_LABEL_HOST_PATTERN.test(host);
}

/** Object literal an expression evaluates to, following in-scope `const` bindings. */
function objectLiteralOf(node: ts.Expression, resolver: ConstantResolver): ts.ObjectLiteralExpression | undefined {
  const expr = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (!ts.isIdentifier(expr)) return undefined;
  const initializer = constInitializer(expr, resolver);
  return initializer ? objectLiteralOf(initializer, deeper(resolver)) : undefined;
}

/** Values of the named properties of an object literal (`{ url: X }` or shorthand `{ url }`). */
function propertyValues(object: ts.ObjectLiteralExpression, names: readonly string[]): ts.Expression[] {
  const values: ts.Expression[] = [];
  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property) && names.includes(property.name.text)) {
      values.push(property.name);
    } else if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      names.includes(property.name.text)
    ) {
      values.push(property.initializer);
    }
  }
  return values;
}

function isRequestCall(callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee) || !REQUEST_METHODS.has(callee.name.text)) return false;
  const receiver = callee.expression;
  if (ts.isIdentifier(receiver)) return REQUEST_RECEIVERS.has(receiver.text);
  return ts.isPropertyAccessExpression(receiver) && REQUEST_RECEIVERS.has(receiver.name.text);
}

/** Name of the object a method is called on: `axios` in `axios.get`, `request` in `page.request.get`. */
function receiverName(callee: ts.PropertyAccessExpression): string | undefined {
  const receiver = callee.expression;
  if (ts.isIdentifier(receiver)) return receiver.text;
  return ts.isPropertyAccessExpression(receiver) ? receiver.name.text : undefined;
}

function optionValues(node: ts.Expression | undefined, names: readonly string[], resolver: ConstantResolver): ts.Expression[] {
  const options = node ? objectLiteralOf(node, resolver) : undefined;
  return options ? propertyValues(options, names) : [];
}

/** URL positions of a method call `receiver.method(...)`. */
/** An expression in a URL position, or in a host position (`node:http(s)` options) when `hostOnly` is set. */
interface UrlTarget {
  expression: ts.Expression;
  hostOnly: boolean;
}

function asUrlTargets(expressions: ts.Expression[]): UrlTarget[] {
  return expressions.map((expression) => ({ expression, hostOnly: false }));
}

/** `node:http(s)` `get` / `request`: a URL first argument, or the host of an options object. */
function nodeHttpTargets(first: ts.Expression, resolver: ConstantResolver): UrlTarget[] {
  const options = objectLiteralOf(first, resolver);
  if (!options) return asUrlTargets([first]);
  return propertyValues(options, NODE_HTTP_HOST_PROPERTIES).map((expression) => ({ expression, hostOnly: true }));
}

/** Whether an identifier is `get` / `request` imported by name from `node:http(s)`. */
function isNodeHttpImport(identifier: ts.Identifier, resolver: ConstantResolver): boolean {
  const declaration = resolver.checker?.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!declaration || !ts.isImportSpecifier(declaration)) return false;
  const imported = (declaration.propertyName ?? declaration.name).text;
  const moduleSpecifier = stringLiteralText(declaration.parent.parent.parent.moduleSpecifier);
  return NODE_HTTP_METHODS.has(imported) && moduleSpecifier !== undefined && NODE_HTTP_MODULES.has(moduleSpecifier);
}

function methodUrlExpressions(node: ts.CallExpression, callee: ts.PropertyAccessExpression, resolver: ConstantResolver): UrlTarget[] {
  const method = callee.name.text;
  const receiver = receiverName(callee);
  const [first] = node.arguments;
  if (BASE_URL_OPTION_CALLEES.has(method)) return asUrlTargets(optionValues(first, BASE_URL_PROPERTIES, resolver));
  if (method === TEST_OPTION_METHOD) {
    const isTestOptions = receiver !== undefined && TEST_OPTION_RECEIVERS.has(receiver);
    return isTestOptions ? asUrlTargets(optionValues(first, BASE_URL_PROPERTIES, resolver)) : [];
  }
  if (receiver === AXIOS_RECEIVER && method === AXIOS_CREATE_METHOD) {
    return asUrlTargets(optionValues(first, BASE_URL_PROPERTIES, resolver));
  }
  if (receiver && NODE_HTTP_RECEIVERS.has(receiver) && NODE_HTTP_METHODS.has(method)) return nodeHttpTargets(first, resolver);
  if (isRequestCall(callee)) {
    const config = objectLiteralOf(first, resolver);
    if (config) return asUrlTargets(propertyValues(config, REQUEST_CONFIG_URL_PROPERTIES));
    const configIndex = receiver === AXIOS_RECEIVER ? AXIOS_CONFIG_ARGUMENT_INDEX.get(method) : undefined;
    const baseUrls = configIndex === undefined ? [] : optionValues(node.arguments[configIndex], BASE_URL_PROPERTIES, resolver);
    return asUrlTargets([first, ...baseUrls]);
  }
  return URL_ARGUMENT_CALLEES.has(method) ? asUrlTargets([first]) : [];
}

/** The arguments of a call or constructor that sit in a URL or host position for that API; bodies and headers are excluded. */
function urlPositionExpressions(node: ts.CallExpression | ts.NewExpression, resolver: ConstantResolver): UrlTarget[] {
  const callee = node.expression;
  const first = node.arguments?.[0];
  if (!first) return [];
  if (ts.isNewExpression(node)) {
    return ts.isIdentifier(callee) && URL_ARGUMENT_CONSTRUCTORS.has(callee.text) ? asUrlTargets([first]) : [];
  }
  if (ts.isPropertyAccessExpression(callee)) return methodUrlExpressions(node, callee, resolver);
  if (!ts.isIdentifier(callee)) return [];
  if (isNodeHttpImport(callee, resolver)) return nodeHttpTargets(first, resolver);
  if (REQUEST_RECEIVERS.has(callee.text)) {
    const config = objectLiteralOf(first, resolver);
    return asUrlTargets(config ? propertyValues(config, REQUEST_CONFIG_URL_PROPERTIES) : [first]);
  }
  if (BASE_URL_OPTION_CALLEES.has(callee.text)) return asUrlTargets(optionValues(first, BASE_URL_PROPERTIES, resolver));
  return URL_ARGUMENT_CALLEES.has(callee.text) ? asUrlTargets([first]) : [];
}

/** One program over the automation files so identifiers resolve through real scopes; no lib or module resolution. */
function createAutomationChecker(files: string[]): { program: ts.Program; checker: ts.TypeChecker } | undefined {
  if (files.length === 0) return undefined;
  const program = ts.createProgram(files, {
    allowJs: true,
    noLib: true,
    noResolve: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.Latest,
    jsx: ts.JsxEmit.Preserve,
    // Each file is its own module so same-named top-level constants in different files never merge.
    moduleDetection: ts.ModuleDetectionKind.Force,
  });
  return { program, checker: program.getTypeChecker() };
}

function checkGovernance(targetDir?: string): Violation[] {
  const violations: Violation[] = [];
  const scanDirs = targetDir ? [targetDir] : [SRC_DIR, TESTS_DIR, path.join(ROOT_DIR, 'scripts')];
  const files = scanDirs
    .flatMap((dir) => scanDirectory(dir, SUPPORTED_EXTENSIONS))
    .filter((f) => !f.endsWith('guard-anti-cheat.ts') && !f.endsWith('guard-anti-cheat-rules.test.ts'));
  const isAutomationFile = (file: string) => {
    const rel = path.relative(ROOT_DIR, file).split(path.sep);
    return rel[0] === 'scripts' || rel[0] === 'tests' || Boolean(targetDir);
  };

  const automationProgram = createAutomationChecker(files.filter(isAutomationFile));

  for (const file of files) {
    const relFile = path.relative(ROOT_DIR, file);
    const automation = isAutomationFile(file);
    const programFile = automation ? automationProgram?.program.getSourceFile(file) : undefined;
    const sourceFile =
      programFile ?? ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const resolver: ConstantResolver = { checker: programFile ? automationProgram?.checker : undefined, depth: 0 };

    const visit = (node: ts.Node) => {
      // G6: built-in modules must be imported with the node: prefix.
      let specifier: string | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = stringLiteralText(node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        specifier = stringLiteralText(node.moduleReference.expression);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        specifier = stringLiteralText(node.arguments[0]);
      }
      if (specifier && NODE_BUILTINS.has(specifier)) {
        const { line, snippet } = getNodeSnippet(sourceFile, node);
        violations.push({
          file: relFile,
          line,
          rule: 'G6-NODE-PREFIX',
          snippet,
          message: `Built-in module "${specifier}" must be imported as "node:${specifier}".`,
          symbol: specifier,
        });
      }

      // G5: automation must not navigate to or fetch a non-local site (e.g. scraping a third-party service).
      if (automation && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
        for (const target of urlPositionExpressions(node, resolver)) {
          const value = staticText(target.expression, resolver);
          const host = target.hostOnly ? optionHost(value) : externalUrlHost(value);
          if (host === undefined || isLocalHost(host)) continue;
          const { line, snippet } = getNodeSnippet(sourceFile, node);
          violations.push({
            file: relFile,
            line,
            rule: 'G5-EXTERNAL-NAVIGATION',
            snippet,
            message: `Script or test reaches the external host "${host}". Automation may only target the local app.`,
            symbol: host,
          });
          break;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

// ============================================================================
// Main Execution & Ratchet Baseline Engine
// ============================================================================
export function runAntiCheatGuard(options: {
  targetDir?: string;
  baselinePath?: string;
  updateBaseline?: boolean;
  strict?: boolean;
} = {}): { violations: Violation[]; success: boolean } {
  const allViolations: Violation[] = [
    ...checkCircularMocking(options.targetDir),
    ...checkSilentPassBypasses(options.targetDir),
    ...checkProductionCheats(options.targetDir),
    ...checkHollowAssertions(options.targetDir),
    ...checkGovernance(options.targetDir),
  ];

  const errors = allViolations.filter((v) => v.severity !== 'warning');
  const warnings = allViolations.filter((v) => v.severity === 'warning');

  if (warnings.length > 0) {
    console.warn(`\x1b[33m⚠️  [WARNING] Found ${warnings.length} non-blocking integrity notice(s):\x1b[0m`);
    for (const w of warnings) {
      console.warn(`  \x1b[33m${w.file}:${w.line}\x1b[0m [${w.rule}] (${w.symbol || 'n/a'}): ${w.message}`);
    }
    console.warn('');
  }

  const baselineFile = options.baselinePath || path.join(ROOT_DIR, 'scripts', 'anti-cheat-baseline.json');

  if (options.updateBaseline) {
    const defaultWpForFile = (v: Violation): string => {
      if (v.file.includes('cad') || (v.symbol && /step|iges|emf|wmf|cgm/i.test(v.symbol))) return 'WP-46';
      if (v.file.includes('font')) return 'WP-42';
      if (v.file.includes('archive')) return 'WP-45';
      if (v.file.includes('office') || v.file.includes('xlsx') || v.file.includes('ods')) return 'WP-43';
      if (v.file.includes('media') || v.file.includes('audio') || v.file.includes('video')) return 'WP-44';
      if (v.file.includes('raw') || v.file.includes('dng')) return 'WP-47';
      if (v.file.includes('ocr')) return 'WP-48';
      if (v.file.includes('pdf')) return 'WP-41';
      return 'WP-03';
    };

    const newBaseline: BaselineEntry[] = errors.map((e) => ({
      rule: e.rule,
      file: e.file,
      symbol: e.symbol,
      reason: e.message,
      owningWP: defaultWpForFile(e),
    }));

    fs.writeFileSync(baselineFile, JSON.stringify(newBaseline, null, 2) + '\n', 'utf-8');
    console.log(`\x1b[32m✅ Successfully updated ratchet baseline with ${newBaseline.length} entries at ${baselineFile}\x1b[0m\n`);
    return { violations: allViolations, success: true };
  }

  if (options.strict || !fs.existsSync(baselineFile)) {
    if (errors.length > 0) {
      console.error(`\x1b[31m❌ [REJECTED] Found ${errors.length} Anti-Cheating violation(s) (strict / no baseline):\x1b[0m\n`);
      for (const e of errors) {
        console.error(`  \x1b[33m${e.file}:${e.line}\x1b[0m [\x1b[31m${e.rule}\x1b[0m] (${e.symbol || 'n/a'})`);
        console.error(`    Snippet : "${e.snippet}"`);
        console.error(`    Reason  : ${e.message}\n`);
      }
      return { violations: allViolations, success: false };
    }
    console.log('\x1b[32m✅ [PASS] Zero shortcuts, zero circular mocks, zero silent passes, zero hollow assertions detected.\x1b[0m\n');
    return { violations: allViolations, success: true };
  }

  // Ratchet Baseline Verification
  const baseline: BaselineEntry[] = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
  const matchedBaselineIndices = new Set<number>();
  const unbaselinedErrors: Violation[] = [];

  for (const err of errors) {
    let matched = false;
    for (let i = 0; i < baseline.length; i++) {
      if (matchedBaselineIndices.has(i)) continue;
      const b = baseline[i];
      if (b.rule === err.rule && b.file === err.file) {
        if (!b.symbol || b.symbol === err.symbol) {
          matchedBaselineIndices.add(i);
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      unbaselinedErrors.push(err);
    }
  }

  const staleBaselineEntries = baseline.filter((_, idx) => !matchedBaselineIndices.has(idx));

  if (unbaselinedErrors.length > 0) {
    console.error(`\x1b[31m❌ [REJECTED] Found ${unbaselinedErrors.length} NEW Anti-Cheating violation(s) NOT covered by ratchet baseline:\x1b[0m\n`);
    for (const e of unbaselinedErrors) {
      console.error(`  \x1b[33m${e.file}:${e.line}\x1b[0m [\x1b[31m${e.rule}\x1b[0m] (${e.symbol || 'n/a'})`);
      console.error(`    Snippet : "${e.snippet}"`);
      console.error(`    Reason  : ${e.message}\n`);
    }
    return { violations: allViolations, success: false };
  }

  if (staleBaselineEntries.length > 0) {
    console.error(`\x1b[31m❌ [RATCHET VIOLATION] Found ${staleBaselineEntries.length} baseline entry/entries that are no longer violated!\x1b[0m`);
    console.error('The baseline MUST ratchet down. Please remove resolved violations from scripts/anti-cheat-baseline.json:\n');
    for (const s of staleBaselineEntries) {
      console.error(`  - [${s.rule}] ${s.file} (${s.symbol || 'n/a'}) [owning: ${s.owningWP}]`);
    }
    console.error('');
    return { violations: allViolations, success: false };
  }

  const wpCounts = baseline.reduce((acc, b) => {
    acc[b.owningWP] = (acc[b.owningWP] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const wpSummary = Object.entries(wpCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([wp, count]) => `${wp}: ${count}`)
    .join(', ');

  console.log(`\x1b[32m✅ [PASS] Zero un-baselined violations detected.\x1b[0m`);
  console.log(`🔒 Active ratchet baseline: ${baseline.length} locked violations (${wpSummary})\n`);
  return { violations: allViolations, success: true };
}

// CLI entry point
if (require.main === module || process.argv[1]?.endsWith('guard-anti-cheat.ts')) {
  console.log('\n🔒 Running EasyConvert Anti-Cheating & Integrity Guard...\n');

  const args = process.argv.slice(2);
  const updateBaseline = args.includes('--update-baseline');
  const strict = args.includes('--strict');
  let targetDir: string | undefined;
  let baselinePath: string | undefined;

  const targetIdx = args.findIndex((a) => a === '--target' || a === '-t');
  if (targetIdx !== -1 && args[targetIdx + 1]) {
    targetDir = path.resolve(args[targetIdx + 1]);
  }

  const baseIdx = args.indexOf('--baseline');
  if (baseIdx !== -1 && args[baseIdx + 1]) {
    baselinePath = path.resolve(args[baseIdx + 1]);
  }

  const { success } = runAntiCheatGuard({
    targetDir,
    baselinePath,
    updateBaseline,
    strict,
  });

  if (!success) {
    process.exit(1);
  }
}
