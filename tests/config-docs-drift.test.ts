import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_SCHEMA, PRODUCTION_ANY_OF_GROUPS, type VariableSpec } from '../src/lib/config/schema';
import { parseConfig } from '../src/lib/config';
import { renderConfigurationDoc, renderEnvExample } from '../src/lib/config/render-docs';

/**
 * docs/configuration.md and .env.example are generated from the schema (`npm run config:docs`). Rendering again in
 * memory and comparing with the committed files fails when the schema changed and the files were not regenerated.
 * The example file is also read back with a line parser that shares no code with the generator.
 */

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', 'configuration.md');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

const doc = readFileSync(DOC_PATH, 'utf8');
const example = readFileSync(EXAMPLE_PATH, 'utf8');

/** Written out from the issue: the variables whose absence stops a production start-up, in schema order. */
const FILL_IN_LINES = ['JWT_SECRET', 'KEY_HASH_PEPPER', 'WEBHOOK_SECRET_KEK', 'JOB_SECRET_KEK', 'STORAGE_DRIVER', 'STORAGE_SIGNING_SECRET'];

interface ExampleLine {
  name: string;
  value: string;
  active: boolean;
}

function exampleAssignments(): ExampleLine[] {
  const lines: ExampleLine[] = [];
  for (const text of example.split('\n')) {
    const match = /^(# )?([A-Z][A-Z0-9_]*)=(.*)$/.exec(text);
    if (match) lines.push({ name: match[2], value: match[3], active: match[1] === undefined });
  }
  return lines;
}

describe('generated configuration files', () => {
  it('docs/configuration.md is what the schema renders', () => {
    expect(doc).toBe(renderConfigurationDoc());
  });

  it('.env.example is what the schema renders', () => {
    expect(example).toBe(renderEnvExample());
  });

  it('notices a schema change that was not regenerated', () => {
    const changed: VariableSpec[] = CONFIG_SCHEMA.map((spec) =>
      spec.name === 'WORKER_CONCURRENCY' ? { ...spec, default: 4 } : spec
    );
    expect(renderConfigurationDoc(changed, PRODUCTION_ANY_OF_GROUPS)).not.toBe(doc);
    expect(renderEnvExample(changed, PRODUCTION_ANY_OF_GROUPS)).not.toBe(example);
    const removed = CONFIG_SCHEMA.filter((spec) => spec.name !== 'REDIS_PORT');
    expect(renderConfigurationDoc(removed, PRODUCTION_ANY_OF_GROUPS)).not.toBe(doc);
    expect(renderEnvExample(removed, PRODUCTION_ANY_OF_GROUPS)).not.toBe(example);
  });
});

describe('.env.example', () => {
  const assignments = exampleAssignments();
  const operatorVariables = CONFIG_SCHEMA.filter((spec) => spec.platformManaged !== true);

  it('lists every operator-set variable exactly once and nothing else', () => {
    expect(assignments.map((line) => line.name).sort()).toEqual(operatorVariables.map((spec) => spec.name).sort());
  });

  it('leaves out the variables the platform sets', () => {
    const names = new Set(assignments.map((line) => line.name));
    for (const name of ['NODE_ENV', 'NEXT_PHASE', 'NEXT_RUNTIME', 'PATH', 'KUBERNETES_SERVICE_HOST']) {
      expect(names.has(name), name).toBe(false);
    }
  });

  it('shows every secret with an empty value and never a default secret', () => {
    const secrets = CONFIG_SCHEMA.filter((spec) => spec.secret).map((spec) => spec.name);
    expect(secrets.length).toBeGreaterThan(10);
    for (const line of assignments.filter((candidate) => secrets.includes(candidate.name))) {
      expect(line.value, line.name).toBe('');
    }
  });

  it('activates only the lines an operator must fill in for production', () => {
    expect(assignments.filter((line) => line.active).map((line) => line.name).sort()).toEqual([...FILL_IN_LINES].sort());
  });

  it('shows the default of each optional variable that has one', () => {
    const byName = new Map(assignments.map((line) => [line.name, line.value]));
    expect(byName.get('WORKER_CONCURRENCY')).toBe('3');
    expect(byName.get('REDIS_PORT')).toBe('6379');
    expect(byName.get('S3_FORCE_PATH_STYLE')).toBe('true');
    expect(byName.get('STRICT_SANDBOX')).toBe('false');
    expect(byName.get('GRAPH_URL_IMPORT_MAX_BYTES')).toBe(String(5 * 1024 ** 3));
  });

  it('is a valid development configuration when used as it stands', () => {
    const env: Record<string, string> = {};
    for (const line of assignments) env[line.name] = line.value;
    const config = parseConfig(env);
    expect(config.WORKER_CONCURRENCY).toBe(3);
    expect(config.STORAGE_DRIVER).toBe('local');
  });
});

describe('docs/configuration.md', () => {
  it('documents every variable of the schema', () => {
    for (const spec of CONFIG_SCHEMA) {
      expect(doc, spec.name).toContain(`| \`${spec.name}\` |`);
    }
  });

  it('states the count of variables it documents', () => {
    expect(doc).toContain(`EasyConvert reads ${CONFIG_SCHEMA.length} environment variables.`);
    const rows = doc.split('\n').filter((line) => /^\| `[A-Z][A-Z0-9_]*` \|/.test(line));
    expect(rows).toHaveLength(CONFIG_SCHEMA.length);
  });
});
