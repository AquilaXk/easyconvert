/**
 * The package path a relationship target names, relative to the directory of the part that holds it; a leading slash is the package root.
 * Either way the path is normalised, so that `/word/./a.bin`, `/word/sub/../a.bin` and `/word//a.bin` name the part `word/a.bin`.
 */
export function resolveZipPath(baseDir: string, relativePath: string): string {
  const parts = (relativePath.startsWith('/') ? relativePath : `${baseDir}/${relativePath}`).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}
