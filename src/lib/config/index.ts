import { configSchema, Config } from './schema';

export interface ConfigurationErrorDetail {
  path: string;
  rule: string;
  message: string;
}

export class ConfigurationError extends Error {
  public readonly errors: ConfigurationErrorDetail[];

  constructor(errors: { path: string; rule?: string; message?: string }[]) {
    const sanitized = errors.map((e) => {
      const rule = e.rule || e.message || 'Invalid configuration';
      return {
        path: e.path,
        rule,
        message: rule,
      };
    });

    const summary = sanitized.map((e) => `${e.path}: ${e.rule}`).join(', ');
    super(`ConfigurationError: ${summary}`);
    this.name = 'ConfigurationError';
    this.errors = sanitized;
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

let cachedConfig: Config | null = null;

/**
 * Resets the cached configuration instance (used primarily in test suites).
 */
export function resetConfig(): void {
  cachedConfig = null;
}

/**
 * Loads and validates application configuration from environment variables.
 * In production or test environments, throws ConfigurationError listing failing variables and rules without leaking values.
 * In development mode, falls back gracefully to defaults so an empty environment succeeds.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { reload?: boolean } = {}
): Config {
  if (cachedConfig && !options.reload && env === process.env) {
    return cachedConfig;
  }

  const parsed = configSchema.safeParse(env);
  const isDevelopment =
    env.NODE_ENV === 'development' ||
    (env.NODE_ENV === undefined && process.env.NODE_ENV === 'development');

  if (!parsed.success) {
    if (!isDevelopment) {
      const errors = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'configuration',
        rule: issue.message,
        message: issue.message,
      }));
      throw new ConfigurationError(errors);
    } else {
      // In development mode, warn and fall back gracefully to default configuration
      const errorSummaries = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
      console.warn(
        `[config] Development configuration warning: invalid settings (${errorSummaries}), falling back to default values.`
      );
      const defaults = configSchema.safeParse({});
      if (defaults.success) {
        const fallbackConfig = Object.freeze(defaults.data);
        if (env === process.env && !options.reload) {
          cachedConfig = fallbackConfig;
        }
        return fallbackConfig;
      }
    }
  }

  if (parsed.success) {
    const config = Object.freeze(parsed.data);
    if (env === process.env && !options.reload) {
      cachedConfig = config;
    }
    return config;
  }

  throw new Error('Unreachable configuration state');
}

export * from './schema';
