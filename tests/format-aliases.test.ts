import { describe, expect, it } from 'vitest';
import { FORMAT_NAME_ALIASES, canonicalFormat, isSameFormat, otherFormats } from '../src/lib/format-aliases';

/** The names of each format that has more than one: the canonical name first, then its aliases. */
const FORMS_OF_FORMAT: ReadonlyArray<readonly [format: string, forms: readonly string[]]> = Object.entries(
  Object.entries(FORMAT_NAME_ALIASES).reduce<Record<string, string[]>>((byFormat, [alias, format]) => {
    (byFormat[format] ??= [format]).push(alias);
    return byFormat;
  }, {})
);

describe('the names of one format', () => {
  it.each(Object.entries(FORMAT_NAME_ALIASES))('%s is another name of %s', (alias, format) => {
    expect(canonicalFormat(alias)).toBe(format);
    expect(isSameFormat(alias, format)).toBe(true);
    expect(isSameFormat(format, alias)).toBe(true);
    expect(isSameFormat(alias, 'png')).toBe(false);
  });

  it.each(FORMS_OF_FORMAT)('%s and all its names (%j) are one format to a list', (format, forms) => {
    for (const own of forms) {
      expect(otherFormats(own, [...forms, 'bmp', 'png'])).toEqual(['bmp', 'png']);
    }
    expect(otherFormats('bmp', [...forms, 'png'])).toEqual([format, 'png']);
    expect(otherFormats('bmp', [...forms].reverse().concat('png'))).toEqual([format, 'png']);
  });

  it('keeps the name a list has when the canonical name is not in it, and keeps the order of the first of each format', () => {
    expect(otherFormats('bmp', ['jfif', 'jpeg', 'png'])).toEqual(['jfif', 'png']);
    expect(otherFormats('bmp', ['png', 'jpeg', 'gif', 'jpg'])).toEqual(['png', 'jpg', 'gif']);
    expect(otherFormats('pdf', [])).toEqual([]);
  });

  it('leaves an id that is no alias as it is, whatever it is called', () => {
    expect(canonicalFormat('constructor')).toBe('constructor');
    expect(otherFormats('pdf', ['pdf', 'constructor', 'toString'])).toEqual(['constructor', 'toString']);
  });
});
