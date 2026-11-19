/**
 * Strict CLI flag parser for operator maintenance scripts under `scripts/`.
 * Fails closed whenever a value flag is missing its argument, is duplicated,
 * or receives another flag (`--...`) as its value (e.g. `--user --apply`).
 */

export interface OperatorCliSpec {
  /** Flags requiring a following argument value (e.g. `['--user', '--tier']`). */
  readonly valueFlags: readonly string[];
  /** Standalone switch flags requiring no value (e.g. `['--apply', '--dry-run']`). */
  readonly booleanFlags?: readonly string[];
}

export type ParsedOperatorCliArgs =
  | {
      ok: true;
      values: ReadonlyMap<string, string>;
      flags: ReadonlySet<string>;
    }
  | {
      ok: false;
      error: string;
    };

function isInvalidFlagValue(value: string | undefined): value is undefined | '' {
  return value === undefined || value.length === 0 || value.startsWith('--');
}

export function parseOperatorCliArgs(
  argv: readonly string[],
  spec: OperatorCliSpec
): ParsedOperatorCliArgs {
  const valueFlagSet = new Set(spec.valueFlags);
  const booleanFlagSet = new Set(spec.booleanFlags ?? []);
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eqAt = token.indexOf('=');
    if (eqAt > 0) {
      const flagName = token.slice(0, eqAt);
      if (!valueFlagSet.has(flagName)) {
        return { ok: false, error: `Unknown or invalid option "${token}".` };
      }
      const inlineValue = token.slice(eqAt + 1);
      if (isInvalidFlagValue(inlineValue)) {
        return { ok: false, error: `Missing or invalid value for ${flagName}.` };
      }
      if (values.has(flagName)) {
        return { ok: false, error: `Duplicate option ${flagName}.` };
      }
      values.set(flagName, inlineValue);
      continue;
    }

    if (valueFlagSet.has(token)) {
      const next = argv[i + 1];
      if (isInvalidFlagValue(next)) {
        return {
          ok: false,
          error: `Missing or invalid value for ${token} (cannot omit value or pass another flag).`,
        };
      }
      if (values.has(token)) {
        return { ok: false, error: `Duplicate option ${token}.` };
      }
      values.set(token, next);
      i += 1;
      continue;
    }

    if (booleanFlagSet.has(token)) {
      flags.add(token);
      continue;
    }

    return { ok: false, error: `Unexpected argument "${token}".` };
  }

  return { ok: true, values, flags };
}
