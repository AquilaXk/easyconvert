import fs from 'node:fs';
import path from 'node:path';

/**
 * The woff2 program of scripts/install-woff2.sh (the pinned source and the files of scripts/woff2/src), as the tests find it: the file
 * the variable `WOFF2_<NAME>_PATH` names, otherwise /usr/local/bin where the script links it. A program whose install directory has no
 * `share/doc/woff2/SOURCE` note is not the pinned one (the 1.0.2 release of a package drops the overlap bit and has no header checks),
 * and null is returned.
 */
export function pinnedWoff2Program(name: 'woff2_compress' | 'woff2_decompress'): string | null {
  const variable = name === 'woff2_compress' ? 'WOFF2_COMPRESS_PATH' : 'WOFF2_DECOMPRESS_PATH';
  const program = process.env[variable] ?? path.join('/usr/local/bin', name);
  if (program === '' || !fs.existsSync(program)) return null;
  const installDir = path.dirname(path.dirname(fs.realpathSync(program)));
  return fs.existsSync(path.join(installDir, 'share', 'doc', 'woff2', 'SOURCE')) ? program : null;
}
