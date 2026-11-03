import { describe, expect, it } from 'vitest';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { FORMAT_NAME_ALIASES, canonicalFormat, collapseAliases, isSameFormat, otherFormats } from '../src/lib/format-aliases';

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
      expect(otherFormats([...forms, 'bmp', 'png'], own)).toEqual(['bmp', 'png']);
    }
    expect(otherFormats([...forms, 'png'], 'bmp')).toEqual([format, 'png']);
    expect(otherFormats([...forms].reverse().concat('png'), 'bmp')).toEqual([format, 'png']);
  });

  it('keeps every name a list has when the canonical name is not in it, and the canonical name where the list put it', () => {
    expect(otherFormats(['jfif', 'jpeg', 'png'], 'bmp')).toEqual(['jfif', 'jpeg', 'png']);
    expect(otherFormats(['png', 'jpeg', 'gif', 'jpg'], 'bmp')).toEqual(['png', 'gif', 'jpg']);
    expect(otherFormats([], 'pdf')).toEqual([]);
  });

  it('drops the names of every format it is given, so a pair page lists neither its source nor its target', () => {
    expect(otherFormats(['jpg', 'png', 'tiff', 'gif'], 'jpeg', 'tif')).toEqual(['png', 'gif']);
    expect(otherFormats(['jpg', 'png'], 'png', 'png')).toEqual(['jpg']);
  });

  it('collapses items by the id they are read by, for a list of formats as for a list of ids', () => {
    const formats = [{ id: 'tif' }, { id: 'png' }, { id: 'tiff' }, { id: 'jfif' }, { id: 'jpeg' }];
    expect(collapseAliases(formats, (format) => format.id)).toEqual([{ id: 'png' }, { id: 'tiff' }, { id: 'jfif' }, { id: 'jpeg' }]);
    expect(collapseAliases(['tif', 'png'], (id) => id)).toEqual(['tif', 'png']);
  });

  it('leaves an id that is no alias as it is, whatever it is called', () => {
    expect(canonicalFormat('constructor')).toBe('constructor');
    expect(otherFormats(['pdf', 'constructor', 'toString'], 'pdf')).toEqual(['constructor', 'toString']);
  });

  it('names every format once in the targets of each registry format and in the sources of each, so no list needs a second rule', () => {
    const entries = Object.entries(FORMAT_REGISTRY);
    const lists = [
      ...entries.map(([id, def]) => [`targets of ${id}`, def.targetFormats] as const),
      ...entries.map(([id]) => [`sources of ${id}`, entries.filter(([, def]) => def.targetFormats.includes(id)).map(([source]) => source)] as const),
    ];
    const repeated = lists.flatMap(([name, ids]) => {
      const names = collapseAliases(ids, (id) => id).map(canonicalFormat);
      return names.length === new Set(names).size ? [] : [name];
    });
    expect(repeated).toEqual([]);
  });
});
