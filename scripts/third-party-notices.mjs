#!/usr/bin/env node
import node_child_process from 'node:child_process';
import node_fs from 'node:fs';
import node_path from 'node:path';

const ROOT_DIR = process.cwd();
const NOTICES_FILE = node_path.join(ROOT_DIR, 'THIRD_PARTY_NOTICES.md');
const ALLOW_FILE = node_path.join(ROOT_DIR, 'licenses.allow.json');

// 1. Read allowlist and exceptions
if (!node_fs.existsSync(ALLOW_FILE)) {
  console.error(`Error: ${ALLOW_FILE} does not exist.`);
  process.exit(1);
}

const allowConfig = JSON.parse(node_fs.readFileSync(ALLOW_FILE, 'utf8'));
const allowedLicenses = new Set(allowConfig.allowed || []);
const exceptions = allowConfig.exceptions || {};

// 2. Run npm ls --omit=dev --all --json
console.log('Resolving production dependencies tree via npm ls...');
const lsOutput = node_child_process.execSync('npm ls --omit=dev --all --json', {
  cwd: ROOT_DIR,
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});

const lsJson = JSON.parse(lsOutput);
const packages = new Map(); // key -> { name, version }

function walkDependencies(deps) {
  for (const [name, info] of Object.entries(deps)) {
    if (info && info.version) {
      const key = `${name}@${info.version}`;
      if (!packages.has(key)) {
        packages.set(key, { name, version: info.version });
      }
    }
    if (info && info.dependencies) {
      walkDependencies(info.dependencies);
    }
  }
}

if (lsJson.dependencies) {
  walkDependencies(lsJson.dependencies);
}

// 3. Scan node_modules to index package locations
const pkgDirMap = new Map(); // key -> absolute path to package directory

function scanNodeModules(nmDir) {
  if (!node_fs.existsSync(nmDir)) return;
  try {
    const entries = node_fs.readdirSync(nmDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = node_path.join(nmDir, entry.name);
        if (entry.name.startsWith('@')) {
          scanScopedDir(fullPath);
        } else {
          checkAndDescendPackage(fullPath);
        }
      }
    }
  } catch (err) {
    console.warn(`Warning: Could not scan ${nmDir}: ${err.message}`);
  }
}

function scanScopedDir(scopedDir) {
  try {
    const entries = node_fs.readdirSync(scopedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = node_path.join(scopedDir, entry.name);
        checkAndDescendPackage(fullPath);
      }
    }
  } catch (err) {
    console.warn(`Warning: Could not scan scoped dir ${scopedDir}: ${err.message}`);
  }
}

function checkAndDescendPackage(pkgDir) {
  const pjsonPath = node_path.join(pkgDir, 'package.json');
  if (node_fs.existsSync(pjsonPath)) {
    try {
      const pkgData = JSON.parse(node_fs.readFileSync(pjsonPath, 'utf8'));
      if (pkgData.name && pkgData.version) {
        const key = `${pkgData.name}@${pkgData.version}`;
        if (!pkgDirMap.has(key)) {
          pkgDirMap.set(key, pkgDir);
        }
      }
    } catch {}
  }

  const nestedNm = node_path.join(pkgDir, 'node_modules');
  if (node_fs.existsSync(nestedNm)) {
    scanNodeModules(nestedNm);
  }
}

scanNodeModules(node_path.join(ROOT_DIR, 'node_modules'));

// 4. Helper to find license file in a package directory
const LICENSE_FILE_REGEX = /^licen[sc]e(\.md|\.txt)?$/i;
const COPYING_FILE_REGEX = /^copying(\.md|\.txt)?$/i;

function findLicenseFile(dir) {
  if (!node_fs.existsSync(dir)) return null;
  try {
    const files = node_fs.readdirSync(dir);
    const licMatch = files.find(f => LICENSE_FILE_REGEX.test(f));
    if (licMatch) return node_path.join(dir, licMatch);
    const copyMatch = files.find(f => COPYING_FILE_REGEX.test(f));
    if (copyMatch) return node_path.join(dir, copyMatch);
  } catch {}
  return null;
}

// 5. Helper to check if a single license identifier is allowed
function isSingleLicenseAllowed(lic, pkgKey, pkgName) {
  if (!lic || lic === 'UNKNOWN') return false;

  // Exact match in allowed
  if (allowedLicenses.has(lic)) return true;

  // Normalized LGPL-3.0 matches LGPL-3.0-or-later / LGPL-3.0-only
  if (allowedLicenses.has('LGPL-3.0') && /^LGPL-3\.0(-or-later|-only)?$/i.test(lic)) {
    return true;
  }

  // Check exceptions
  const exc = exceptions[pkgKey] || exceptions[pkgName];
  if (exc) {
    const excLic = typeof exc === 'string' ? exc : exc.license;
    if (excLic === lic || allowedLicenses.has(excLic)) {
      return true;
    }
  }

  return false;
}

// Helper to evaluate SPDX license expressions e.g. "(MIT OR GPL-3.0-or-later)" or "(MIT AND Zlib)"
function isLicenseExpressionAllowed(licExpression, pkgKey, pkgName) {
  const trimmed = licExpression.trim();

  // If directly allowed or exception
  if (isSingleLicenseAllowed(trimmed, pkgKey, pkgName)) {
    return true;
  }

  // Handle OR expression: (A OR B) -> allowed if either A or B is allowed
  if (trimmed.includes(' OR ')) {
    const parts = trimmed.replace(/[()]/g, '').split(/\s+OR\s+/i);
    return parts.some(part => isSingleLicenseAllowed(part.trim(), pkgKey, pkgName));
  }

  // Handle AND expression: (A AND B) -> allowed if all parts are allowed
  if (trimmed.includes(' AND ')) {
    const parts = trimmed.replace(/[()]/g, '').split(/\s+AND\s+/i);
    return parts.every(part => isSingleLicenseAllowed(part.trim(), pkgKey, pkgName));
  }

  return false;
}

// 6. Process each package
const sortedKeys = Array.from(packages.keys()).sort((a, b) => a.localeCompare(b));
const packageNotices = [];
const disallowedPackages = [];

for (const pkgKey of sortedKeys) {
  const { name, version } = packages.get(pkgKey);
  const pkgDir = pkgDirMap.get(pkgKey);

  let license = 'UNKNOWN';
  let author = '';
  let homepage = '';
  let repository = '';
  let licenseText = '';
  let bundledNotices = '';

  if (pkgDir) {
    const pjsonPath = node_path.join(pkgDir, 'package.json');
    if (node_fs.existsSync(pjsonPath)) {
      try {
        const pjson = JSON.parse(node_fs.readFileSync(pjsonPath, 'utf8'));
        if (pjson.license) {
          license = typeof pjson.license === 'string' ? pjson.license : pjson.license.type || JSON.stringify(pjson.license);
        } else if (pjson.licenses && Array.isArray(pjson.licenses)) {
          license = pjson.licenses.map(l => (typeof l === 'string' ? l : l.type || JSON.stringify(l))).join(' OR ');
        }

        if (pjson.author) {
          author = typeof pjson.author === 'string' ? pjson.author : `${pjson.author.name || ''} ${pjson.author.email ? `<${pjson.author.email}>` : ''}`.trim();
        }
        if (pjson.homepage) {
          homepage = pjson.homepage;
        }
        if (pjson.repository) {
          repository = typeof pjson.repository === 'string' ? pjson.repository : pjson.repository.url || '';
        }
      } catch {}
    }

    // License file search
    const licFilePath = findLicenseFile(pkgDir);
    if (licFilePath) {
      try {
        licenseText = node_fs.readFileSync(licFilePath, 'utf8').trim();
        // If license was UNKNOWN in package.json, infer from text
        if (license === 'UNKNOWN') {
          if (/MIT\s+License/i.test(licenseText)) {
            license = 'MIT';
          } else if (/Apache\s+License/i.test(licenseText)) {
            license = 'Apache-2.0';
          } else if (/BSD/i.test(licenseText)) {
            license = 'BSD-3-Clause';
          }
        }
      } catch {}
    }

    // Check if prebuilt binary package with its own notice / licensing in README (e.g. sharp-libvips)
    const readmePath = node_path.join(pkgDir, 'README.md');
    if (node_fs.existsSync(readmePath) && name.includes('libvips')) {
      try {
        const readmeContent = node_fs.readFileSync(readmePath, 'utf8');
        const licIndex = readmeContent.indexOf('## Licensing');
        if (licIndex !== -1) {
          bundledNotices = readmeContent.slice(licIndex).trim();
        }
      } catch {}
    }
  }

  // Fallback check exception for license
  if (license === 'UNKNOWN' && (exceptions[pkgKey] || exceptions[name])) {
    const exc = exceptions[pkgKey] || exceptions[name];
    license = typeof exc === 'string' ? exc : exc.license;
  }

  // Validate license against allowlist
  const isAllowed = isLicenseExpressionAllowed(license, pkgKey, name);
  if (!isAllowed) {
    disallowedPackages.push({ pkgKey, license });
  }

  packageNotices.push({
    key: pkgKey,
    name,
    version,
    license,
    author,
    homepage,
    repository,
    licenseText,
    bundledNotices,
  });
}

// 7. Check for disallowed licenses
if (disallowedPackages.length > 0) {
  console.error('\n❌ Disallowed license(s) detected in production dependencies:');
  for (const { pkgKey, license } of disallowedPackages) {
    console.error(`  - ${pkgKey}: "${license}" (not in licenses.allow.json)`);
  }
  process.exit(1);
}

// 8. Generate THIRD_PARTY_NOTICES.md content
const lines = [
  '# Third-Party Software Notices',
  '',
  'This document lists the third-party production software packages and native libraries used in EasyConvert along with their licence terms and copyright notices.',
  '',
  `Total packages: ${packageNotices.length}`,
  '',
  '---',
  '',
];

for (const pkg of packageNotices) {
  lines.push(`### ${pkg.name}@${pkg.version}`);
  lines.push('');
  lines.push(`- **License**: \`${pkg.license}\``);
  if (pkg.author) {
    lines.push(`- **Author**: ${pkg.author}`);
  }
  if (pkg.repository) {
    lines.push(`- **Repository**: ${pkg.repository}`);
  }
  if (pkg.homepage) {
    lines.push(`- **Homepage**: ${pkg.homepage}`);
  }
  lines.push('');

  if (pkg.licenseText) {
    lines.push('```text');
    lines.push(pkg.licenseText);
    lines.push('```');
    lines.push('');
  }

  if (pkg.bundledNotices) {
    lines.push('#### Bundled Native Libraries Notices');
    lines.push('');
    lines.push(pkg.bundledNotices);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
}

const generatedMarkdown = lines.join('\n');

// 9. Handle --check mode or write mode
const isCheckMode = process.argv.includes('--check');

if (isCheckMode) {
  if (!node_fs.existsSync(NOTICES_FILE)) {
    console.error(`❌ Check failed: ${NOTICES_FILE} does not exist. Run "node scripts/third-party-notices.mjs" to generate it.`);
    process.exit(1);
  }
  const existingContent = node_fs.readFileSync(NOTICES_FILE, 'utf8');
  if (existingContent !== generatedMarkdown) {
    console.error(`❌ Check failed: ${NOTICES_FILE} has drifted from actual production dependencies.`);
    console.error('Run "node scripts/third-party-notices.mjs" to regenerate it.');
    process.exit(1);
  }
  console.log('✅ License check passed. THIRD_PARTY_NOTICES.md is up-to-date.');
} else {
  node_fs.writeFileSync(NOTICES_FILE, generatedMarkdown, 'utf8');
  console.log(`✅ Successfully generated ${NOTICES_FILE} (${packageNotices.length} packages).`);
}
