/**
 * The same text as a flat string. V8 keeps `a + b` as a tree until it is first read whole; slicing reads it, so the
 * result is a view of one flat string instead of a tree that every later copy walks again. Worth it for text that many
 * rows repeat.
 */
export function flatCopy(text: string): string {
  return `${text} `.slice(0, text.length);
}
