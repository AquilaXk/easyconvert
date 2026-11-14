const PERCENT_ENCODED_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/** Decodes valid RFC 3986 percent-encoded octets in an OPC part/relationship URI segment (ECMA-376 Part 2 §9.1.1.1.2). */
export function decodeOpcUriPath(rawPath: string): string {
  if (!rawPath.includes('%')) return rawPath;
  return rawPath.replace(PERCENT_ENCODED_RUN, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });
}

/**
 * The package path a relationship target names, relative to the directory of the part that holds it; a leading slash is the package root.
 * Either way the path is percent-decoded and normalised, so that `/word/./a.bin`, `/word/sub/../a.bin` and `/word/%76baProject.bin` name the part.
 */
export function resolveZipPath(baseDir: string, relativePath: string): string {
  const decoded = decodeOpcUriPath(relativePath).replace(/\\/g, '/');
  const parts = (decoded.startsWith('/') ? decoded : `${baseDir}/${decoded}`).split('/');
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
