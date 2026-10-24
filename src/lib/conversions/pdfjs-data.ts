import path from 'node:path';
import { createRequire } from 'node:module';

/** A data folder of pdfjs-dist (`standard_fonts`, `cmaps`, `wasm`), as the path pdfjs reads its files from in Node. */
export function pdfjsDataUrl(folder: string): string | undefined {
  try {
    const manifest = createRequire(path.join(process.cwd(), 'package.json')).resolve('pdfjs-dist/package.json');
    return `${path.join(path.dirname(manifest), folder)}${path.sep}`;
  } catch {
    return undefined;
  }
}
