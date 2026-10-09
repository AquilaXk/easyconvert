import {
  CONFIG_SCHEMA,
  PRODUCTION_ANY_OF_GROUPS,
  ConfigRuleError,
  parseKind,
  type Config,
  type ParsedValue,
  type ProcessRole,
  type VariableSpec,
} from './schema';

export { CONFIG_SCHEMA, PRODUCTION_ANY_OF_GROUPS } from './schema';
export type { Config, ConfigName, ProcessRole, VariableSpec } from './schema';

/**
 * Typed, validated configuration. `loadConfig` reads the environment once, checks every variable of the schema
 * and freezes the result. Start-up code calls it so that a bad configuration stops the process before it
 * connects to anything: the web server from src/instrumentation.ts, the worker from src/worker/index.ts.
 *
 * Rules:
 * - An unset or blank variable takes its default. Blank counts as unset because compose files and shells pass
 *   unused variables as empty strings.
 * - A set variable that does not parse is an error in every environment; it never falls back to the default.
 * - With NODE_ENV=production a variable marked `requiredInProduction` (and the alternatives of
 *   PRODUCTION_ANY_OF_GROUPS) must be set. `next build` runs with NODE_ENV=production and
 *   NEXT_PHASE=phase-production-build and has no runtime environment, so requirements are not enforced there.
 * - Every failing variable is collected into one ConfigurationError that names the variable and the rule, never
 *   the value.
 */

const PRODUCTION = 'production';
const PRODUCTION_BUILD_PHASE = 'phase-production-build';

type Env = Readonly<Record<string, string | undefined>>;

export interface ConfigFailure {
  readonly variable: string;
  /** Fixed text describing the rule that was broken; never contains the value. */
  readonly rule: string;
}

/** One or more variables are missing or malformed. The message lists each variable and its rule, not its value. */
export class ConfigurationError extends Error {
  readonly failures: readonly ConfigFailure[];

  constructor(failures: readonly ConfigFailure[]) {
    const lines = failures.map((failure) => `  - ${failure.variable}: ${failure.rule}`);
    super(
      `Invalid configuration, ${failures.length} ${failures.length === 1 ? 'problem' : 'problems'}:\n${lines.join('\n')}\n` +
        'docs/configuration.md lists every variable with its rule.'
    );
    this.name = 'ConfigurationError';
    this.failures = failures;
  }

  /** The names of the failing variables. */
  get variables(): readonly string[] {
    return this.failures.map((failure) => failure.variable);
  }
}

export interface LoadConfigOptions {
  /**
   * The process that loads the configuration. Production requirements apply to the variables read by that
   * process; without a role every requirement applies.
   */
  readonly role?: ProcessRole;
}

function isBlank(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === '';
}

function defaultFor(spec: VariableSpec, production: boolean): ParsedValue {
  if (spec.default !== undefined) return spec.default;
  if (!production && spec.developmentDefault !== undefined) return spec.developmentDefault;
  return undefined;
}

/** Names that a set name earlier in the same first-set-wins group shadows. */
function shadowedNames(env: Env): ReadonlySet<string> {
  const shadowed = new Set<string>();
  for (const group of PRODUCTION_ANY_OF_GROUPS) {
    if (!group.firstSetWins) continue;
    const winner = group.names.findIndex((name) => !isBlank(env[name]));
    if (winner < 0) continue;
    for (const name of group.names.slice(winner + 1)) shadowed.add(name);
  }
  return shadowed;
}

function appliesTo(roles: readonly ProcessRole[], role: ProcessRole | undefined): boolean {
  return role === undefined || roles.includes(role);
}

/** Validates `env` against the schema without caching. Throws ConfigurationError listing every failing variable. */
export function parseConfig(env: Env, options: LoadConfigOptions = {}): Config {
  const production = env.NODE_ENV === PRODUCTION && env.NEXT_PHASE !== PRODUCTION_BUILD_PHASE;
  const values = new Map<string, ParsedValue>();
  const isSet = new Set<string>();
  const failures: ConfigFailure[] = [];
  const shadowed = shadowedNames(env);

  for (const spec of CONFIG_SCHEMA) {
    const raw = env[spec.name];
    if (isBlank(raw)) {
      values.set(spec.name, defaultFor(spec, production));
      continue;
    }
    isSet.add(spec.name);
    try {
      values.set(spec.name, parseKind(spec.kind, raw as string, { production: production && !shadowed.has(spec.name) }));
    } catch (error) {
      if (!(error instanceof ConfigRuleError)) throw error;
      failures.push({ variable: spec.name, rule: error.rule });
    }
  }

  for (const spec of CONFIG_SCHEMA) {
    const unset = !isSet.has(spec.name);
    if (spec.requires !== undefined && !unset && !isSet.has(spec.requires.variable)) {
      failures.push({ variable: spec.name, rule: `requires ${spec.requires.variable} ${spec.requires.because}` });
    }
    if (!production || !unset || !appliesTo(spec.roles, options.role)) continue;
    if (spec.requiredInProduction) {
      failures.push({ variable: spec.name, rule: 'is required in production' });
    } else if (spec.requiredWhen !== undefined && values.get(spec.requiredWhen.variable) === spec.requiredWhen.equals) {
      failures.push({
        variable: spec.name,
        rule: `is required in production when ${spec.requiredWhen.variable} is ${spec.requiredWhen.equals}`,
      });
    }
  }

  if (production) {
    for (const group of PRODUCTION_ANY_OF_GROUPS) {
      if (!appliesTo(group.roles, options.role) || group.names.some((name) => isSet.has(name))) continue;
      failures.push({ variable: group.names[0], rule: `one of ${group.names.join(', ')} is required in production` });
    }
  }

  if (failures.length > 0) throw new ConfigurationError(failures);
  return Object.freeze(Object.fromEntries(values)) as Config;
}

let cached: Config | undefined;

/**
 * Parses the environment once and returns the same frozen object on every later call. A failure is not cached.
 * Defaults to `process.env`; this is the only place the application reads the whole environment.
 */
export function loadConfig(env: Env = process.env, options: LoadConfigOptions = {}): Config {
  cached ??= parseConfig(env, options);
  return cached;
}

/** Forgets the cached configuration; for tests. */
export function resetConfigCache(): void {
  cached = undefined;
}
