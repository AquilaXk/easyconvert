/**
 * Registry formats that are another name of the same format (an extension spelled two ways), keyed by the alias and naming
 * the format it stands for. A list of targets names each format once: "JPG" covers JPEG and JFIF, "TIFF" covers TIF.
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
