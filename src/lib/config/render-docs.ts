import {
  CONFIG_SCHEMA,
  MAX_CIDR_LIST_ENTRIES,
  PRODUCTION_ANY_OF_GROUPS,
  type AnyOfGroup,
  type ConfigArea,
  type ValueKind,
  type VariableSpec,
} from './schema';

/**
 * Renders docs/configuration.md and .env.example from the schema. Pure functions: scripts/generate-config-docs.ts
 * writes the files, and tests/config-docs-drift.test.ts renders again and compares with the committed files, so a
 * schema change that is not regenerated fails the test.
 */

const GENERATED_NOTICE = 'Generated from src/lib/config/schema.ts by `npm run config:docs`. Do not edit by hand.';
/** Width at which .env.example wraps its comments. */
const ENV_COMMENT_WIDTH = 100;

const AREA_ORDER: readonly ConfigArea[] = [
  'runtime',
  'network',
  'security',
  'auth',
  'secrets',
  'storage',
  'queue',
  'worker',
  'limits',
  'tools',
  'ui',
];

const AREA_TITLES: Readonly<Record<ConfigArea, string>> = {
  runtime: 'Runtime',
  network: 'Network and public URLs',
  security: 'Client address trust and sandbox',
  auth: 'Sign-in',
  secrets: 'Keys and secrets',
  storage: 'Object storage',
  queue: 'Queue and Redis',
  worker: 'Worker',
  limits: 'Limits',
  tools: 'Native tools',
  ui: 'Page',
};

function code(text: string): string {
  return `\`${text}\``;
}

function describeScheme(scheme: string): string {
  return code(scheme.replace(/:$/, ''));
}

function describeKind(kind: ValueKind): string {
  switch (kind.type) {
    case 'integer':
      return kind.max === Number.MAX_SAFE_INTEGER ? `integer, at least ${kind.min}` : `integer, ${kind.min} to ${kind.max}`;
    case 'url': {
      const parts = [`URL with the scheme ${kind.schemes.map(describeScheme).join(' or ')}`];
      if (kind.productionSchemes !== undefined) parts.push(`${kind.productionSchemes.map(describeScheme).join(' or ')} only in production`);
      if (kind.rejectUserInfo === true) parts.push('no user info');
      return parts.join(', ');
    }
    case 'secret': {
      const parts = [`secret, at least ${kind.minBytes} bytes of UTF-8 text in production (the text is measured, never decoded)`];
      if (kind.trim) parts.push('surrounding whitespace is trimmed');
      if (kind.rejectSurroundingWhitespace) parts.push('no surrounding whitespace in production');
      return parts.join(', ');
    }
    case 'credential':
      return 'secret text';
    case 'cidrList':
      return `comma-separated IPv4/IPv6 addresses or CIDR ranges${kind.allowNone ? ` or ${code('none')}` : ''}, at most ${MAX_CIDR_LIST_ENTRIES} entries`;
    case 'enum':
      return `one of ${kind.values.map(code).join(', ')}${kind.caseInsensitive ? ' (any case)' : ''}`;
    case 'executable':
      return 'path or command name of an executable (existence is not checked at start-up)';
    case 'path':
      return 'file or directory path';
    case 'boolean':
      return `${code('true')} or ${code('false')}`;
    case 'string':
      return 'text';
  }
}

function formatValue(value: string | number | boolean): string {
  return String(value);
}

function describeDefault(spec: VariableSpec): string {
  if (spec.default !== undefined) return code(formatValue(spec.default));
  if (spec.developmentDefault !== undefined) return `${code(formatValue(spec.developmentDefault))} (development only)`;
  if (spec.computedDefault !== undefined) return spec.computedDefault;
  return 'none';
}

function describeRequirement(spec: VariableSpec, groups: readonly AnyOfGroup[]): string {
  const group = groups.find((candidate) => candidate.names.includes(spec.name));
  if (spec.requiredInProduction) return 'yes';
  if (spec.requiredWhen !== undefined) return `when ${code(spec.requiredWhen.variable)} is ${code(spec.requiredWhen.equals)}`;
  if (group !== undefined) return `one of ${group.names.map(code).join(', ')}`;
  return 'no';
}

function describeRoles(spec: VariableSpec): string {
  return spec.roles.join(', ');
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function specsOf(area: ConfigArea, schema: readonly VariableSpec[]): VariableSpec[] {
  return schema.filter((spec) => spec.area === area);
}

/** docs/configuration.md. */
export function renderConfigurationDoc(
  schema: readonly VariableSpec[] = CONFIG_SCHEMA,
  groups: readonly AnyOfGroup[] = PRODUCTION_ANY_OF_GROUPS
): string {
  const lines: string[] = [
    '# Configuration',
    '',
    `<!-- ${GENERATED_NOTICE} -->`,
    '',
    `EasyConvert reads ${schema.length} environment variables. The schema in ${code('src/lib/config/schema.ts')} declares each one with its type, default, production requirement and owning area; this page and ${code('.env.example')} are generated from it.`,
    '',
    '## How the configuration is checked',
    '',
    `- The web server (${code('src/instrumentation.ts')}) and the worker (${code('src/worker/index.ts')}) validate the whole environment once at start-up, before they connect to anything, and keep the result frozen.`,
    '- A variable that is unset, or set to an empty or blank value, takes its default. Compose files and shells pass unused variables as empty strings, so empty counts as unset.',
    '- A variable that is set but malformed is an error in every environment. It never falls back to the default.',
    `- With ${code('NODE_ENV=production')} the variables marked as required must be set, and secrets must be long enough. \`next build\` has no runtime environment, so requirements are not enforced there (${code('NEXT_PHASE=phase-production-build')}).`,
    `- Every failing variable is reported in one ${code('ConfigurationError')} that names the variable and the rule it broke. The value is never printed. The process exits with a non-zero status.`,
    '- Secrets have no default. Their length is measured on the UTF-8 text exactly as the code that uses them reads it: hex and base64 are not decoded, so `openssl rand -hex 32` (64 characters) is a valid secret.',
    '- The Process column says which process reads the variable and enforces its production requirement: `web` is the Next.js server, `worker` the queue worker.',
    '',
    'Generate a secret with `openssl rand -hex 32`.',
    '',
    '## Variables',
  ];

  for (const area of AREA_ORDER) {
    const specs = specsOf(area, schema);
    if (specs.length === 0) continue;
    lines.push('', `### ${AREA_TITLES[area]}`, '', '| Variable | Type and rule | Default | Required in production | Process |', '| --- | --- | --- | --- | --- |');
    for (const spec of specs) {
      const rule = `${describeKind(spec.kind)}${spec.secret ? '; secret, never logged' : ''}`;
      lines.push(
        `| ${code(spec.name)} | ${escapeCell(rule)} | ${escapeCell(describeDefault(spec))} | ${escapeCell(describeRequirement(spec, groups))} | ${describeRoles(spec)} |`
      );
    }
    lines.push('');
    for (const spec of specs) {
      lines.push(`- ${code(spec.name)}: ${spec.description}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** Wraps `text` at `width` columns on word boundaries; a word longer than the width stays whole. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

/** True when the example file lists the variable as a line to fill in rather than as an optional comment. */
function isRequiredLine(spec: VariableSpec, groups: readonly AnyOfGroup[]): boolean {
  if (spec.requiredInProduction) return true;
  return groups.some((group) => group.names[0] === spec.name);
}

/** .env.example: every operator-set variable, secrets always empty. */
export function renderEnvExample(
  schema: readonly VariableSpec[] = CONFIG_SCHEMA,
  groups: readonly AnyOfGroup[] = PRODUCTION_ANY_OF_GROUPS
): string {
  const commentWidth = ENV_COMMENT_WIDTH - '# '.length;
  const lines: string[] = [
    ...wrap(GENERATED_NOTICE, commentWidth).map((line) => `# ${line}`),
    '#',
    ...wrap(
      'Copy this file to .env and fill in the lines without a leading #. The other lines show optional variables with their default; remove the # to change one. An empty value counts as unset. Secrets are never given a default value: generate each with `openssl rand -hex 32`. The same text with the rule of every variable is in docs/configuration.md.',
      commentWidth
    ).map((line) => `# ${line}`),
  ];

  for (const area of AREA_ORDER) {
    const specs = specsOf(area, schema).filter((spec) => spec.platformManaged !== true);
    if (specs.length === 0) continue;
    lines.push('', `# --- ${AREA_TITLES[area]} ---`);
    for (const spec of specs) {
      lines.push('');
      for (const line of wrap(spec.description, commentWidth)) lines.push(`# ${line}`);
      lines.push(`# Rule: ${describeKind(spec.kind).replace(/`/g, '')}.`);
      if (spec.developmentDefault !== undefined) lines.push(`# Development default: ${formatValue(spec.developmentDefault)}.`);
      if (spec.computedDefault !== undefined) lines.push(`# Default: ${spec.computedDefault}.`);
      const value = spec.secret || spec.default === undefined ? '' : formatValue(spec.default);
      const required = isRequiredLine(spec, groups);
      lines.push(`${required ? '' : '# '}${spec.name}=${value}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
