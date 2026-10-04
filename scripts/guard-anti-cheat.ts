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
 * 4. Hollow & Weak Assertions (G4, G4b): Tautologies and tests composed exclusively of weak assertions.
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
  }

  return violations;
}

// ============================================================================
// Gate 5: Governance (AST G5 external navigation + AST G6 built-in specifier)
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
/** Receivers whose HTTP-verb methods issue a request (`page.request.get`, `request.post`, `axios.get`). */
const REQUEST_RECEIVERS: ReadonlySet<string> = new Set(['request', 'axios']);
const REQUEST_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'fetch', 'request']);
/** Scheme plus a host that is already terminated, so a partially known URL still names its full host. */
const URL_WITH_COMPLETE_HOST = /^https?:\/\/[^/?#:]+[/?#:]/i;
/** Scheme and terminated host of a partially known URL. */
const URL_ORIGIN_PREFIX = /^https?:\/\/[^/?#:]+/i;
/** A URL input that carries its own scheme and therefore ignores the base passed to `new URL`. */
const ABSOLUTE_URL_INPUT = /^[a-z][a-z0-9+.-]*:/i;
/** Bound on chained constant lookups (`const A = B; const B = ...`) so cyclic references terminate. */
const MAX_CONSTANT_RESOLUTION_DEPTH = 16;
const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules.filter((m) => !m.startsWith('_')));

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
}

/** Statically known leading text of a string expression; `complete` is false when a suffix is unknown. */
interface StaticText {
  text: string;
  complete: boolean;
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

function staticText(node: ts.Expression, resolver: ConstantResolver): StaticText | undefined {
  const expr = unwrapExpression(node);
  const literal = stringLiteralText(expr);
  if (literal !== undefined) return { text: literal, complete: true };
  if (ts.isIdentifier(expr)) {
    const initializer = constInitializer(expr, resolver);
    return initializer ? staticText(initializer, deeper(resolver)) : undefined;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return joinStatic(staticText(expr.left, resolver), () => staticText(expr.right, resolver));
  }
  if (ts.isTaggedTemplateExpression(expr)) return staticText(expr.template, resolver);
  if (ts.isTemplateExpression(expr)) {
    let acc: StaticText = { text: expr.head.text, complete: true };
    for (const span of expr.templateSpans) {
      const joined = joinStatic(acc, () => staticText(span.expression, resolver));
      if (!joined || !joined.complete) return joined;
      acc = { text: joined.text + span.literal.text, complete: true };
    }
    return acc;
  }
  if (ts.isNewExpression(expr)) return urlConstructorText(expr, resolver);
  return undefined;
}

function joinStatic(left: StaticText | undefined, right: () => StaticText | undefined): StaticText | undefined {
  if (!left) return undefined;
  if (!left.complete) return left;
  const rhs = right();
  if (!rhs) return left.text ? { text: left.text, complete: false } : undefined;
  return { text: left.text + rhs.text, complete: rhs.complete };
}

/** `new URL(input, base)`: the resolved href, or the base origin when the relative input is unknown. */
function urlConstructorText(node: ts.NewExpression, resolver: ConstantResolver): StaticText | undefined {
  const args = node.arguments ?? [];
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'URL' || args.length === 0) return undefined;
  const input = staticText(args[0], resolver);
  if (args.length === 1) return input;
  if (input && ABSOLUTE_URL_INPUT.test(input.text)) return input;
  const base = staticText(args[1], resolver);
  if (!base || externalUrlHost(base) === undefined) return undefined;
  if (input?.complete && base.complete) {
    try {
      return { text: new URL(input.text, base.text).href, complete: true };
    } catch {
      return undefined;
    }
  }
  const origin = URL_ORIGIN_PREFIX.exec(base.text)?.[0];
  return origin ? { text: `${origin}/`, complete: false } : undefined;
}

/** Host of an http(s) URL whose host part is statically known, or undefined when it is not a URL. */
function externalUrlHost(value: StaticText): string | undefined {
  if (!/^https?:\/\//i.test(value.text)) return undefined;
  if (!value.complete && !URL_WITH_COMPLETE_HOST.test(value.text)) return undefined;
  try {
    return new URL(value.text).hostname;
  } catch {
    // A complete literal that fails to parse is still an attempt to reach a site: fail closed.
    return value.complete ? '' : undefined;
  }
}

function isLocalHost(host: string): boolean {
  const name = host.toLowerCase();
  return (
    LOCAL_HOST_NAMES.has(name) ||
    LOOPBACK_IPV4_PATTERN.test(name) ||
    RESERVED_LOCAL_SUFFIX_PATTERN.test(name) ||
    DOCUMENTATION_DOMAIN_PATTERN.test(name) ||
    SINGLE_LABEL_HOST_PATTERN.test(name)
  );
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

/** The argument expressions of a call that sit in a URL position for that API; bodies and headers are excluded. */
function urlPositionExpressions(node: ts.CallExpression, resolver: ConstantResolver): ts.Expression[] {
  const callee = node.expression;
  const first = node.arguments[0];
  if (!first) return [];
  let calleeName: string | undefined;
  if (ts.isIdentifier(callee)) calleeName = callee.text;
  else if (ts.isPropertyAccessExpression(callee)) calleeName = callee.name.text;
  if (calleeName === undefined) return [];

  if (BASE_URL_OPTION_CALLEES.has(calleeName)) {
    const options = objectLiteralOf(first, resolver);
    return options ? propertyValues(options, BASE_URL_PROPERTIES) : [];
  }
  const isRequest = (ts.isIdentifier(callee) && REQUEST_RECEIVERS.has(calleeName)) || isRequestCall(callee);
  if (isRequest) {
    const config = objectLiteralOf(first, resolver);
    return config ? propertyValues(config, REQUEST_CONFIG_URL_PROPERTIES) : [first];
  }
  return URL_ARGUMENT_CALLEES.has(calleeName) ? [first] : [];
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
      if (automation && ts.isCallExpression(node)) {
        for (const target of urlPositionExpressions(node, resolver)) {
          const value = staticText(target, resolver);
          const host = value ? externalUrlHost(value) : undefined;
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
