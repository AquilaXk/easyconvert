/** The package path a relationship target names, relative to the directory of the part that holds it; a leading slash is the package root. */
export function resolveZipPath(baseDir: string, relativePath: string): string {
  if (relativePath.startsWith('/')) {
    return relativePath.slice(1);
  }
  const parts = `${baseDir}/${relativePath}`.split('/');
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
