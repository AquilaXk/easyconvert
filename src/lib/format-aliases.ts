/**
 * Registry formats that are another name of the same format (an extension spelled two ways), keyed by the alias and naming
 * the format it stands for. A list of targets names each format once, so "JPG" covers JPEG and JFIF and "TIFF" covers TIF.
 */
export const FORMAT_NAME_ALIASES: Readonly<Record<string, string>> = {
  jpeg: 'jpg',
  jfif: 'jpg',
  tif: 'tiff',
  htm: 'html',
  text: 'txt',
  yml: 'yaml',
  mpeg: 'mpg',
  aif: 'aiff',
  midi: 'mid',
  '3gpp': '3gp',
  djv: 'djvu',
  zstd: 'zst',
  igs: 'iges',
  stp: 'step',
  'tar.gz': 'tgz',
  'tar.bz2': 'tbz2',
  'tar.bz': 'tbz2',
  tbz: 'tbz2',
};

/** The format a registry id names, with an alias resolved to the format it stands for. */
export function canonicalFormat(id: string): string {
  return Object.hasOwn(FORMAT_NAME_ALIASES, id) ? FORMAT_NAME_ALIASES[id] : id;
}

/** Whether two registry ids name one format, either the same id or two names of it (JPEG and JPG, JPEG and JFIF). */
export function isSameFormat(id: string, other: string): boolean {
  return canonicalFormat(id) === canonicalFormat(other);
}

/**
 * Each format of `items` once, by its own name. An item that is another name of a format whose own name is also in
 * `items` is dropped, an id the list holds twice stays where it first stood, and the others stay in place, so a format
 * whose own name is absent keeps every name it has.
 */
export function collapseAliases<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  const offered = new Set(items.map(idOf));
  const kept = new Set<string>();
  return items.filter((item) => {
    const id = idOf(item);
    if (kept.has(id) || (canonicalFormat(id) !== id && offered.has(canonicalFormat(id)))) return false;
    kept.add(id);
    return true;
  });
}

/** The formats of `ids` other than those `own` names, each named once as `collapseAliases` names it. */
export function otherFormats(ids: readonly string[], own: readonly string[]): string[] {
  const ownFormats = new Set(own.map(canonicalFormat));
  return collapseAliases(
    ids.filter((id) => !ownFormats.has(canonicalFormat(id))),
    (id) => id
  );
}
