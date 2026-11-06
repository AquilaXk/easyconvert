/**
 * The forms of an environment secret that data may have been sealed under: the trimmed value, then
 * the raw value when it differs (older releases used the raw text). Empty values yield no forms.
 */
export function secretForms(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return [raw];
  }
  return trimmed === raw ? [raw] : [trimmed, raw];
}

/** Minimum length, in characters, of a key that seals new data in production. */
export const MIN_PRODUCTION_SEALING_KEY_LENGTH = 32;
