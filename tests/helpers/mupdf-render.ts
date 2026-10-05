import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * MuPDF (PyMuPDF) as the independent renderer for OpenXPS output. Pixels are sampled at 72 dpi, where one
 * XPS device-independent unit (1/96 inch) is 0.75 pixel.
 */

const RENDER_SCRIPT = `
import sys, json
try:
    import pymupdf as mu
except ImportError:
    import fitz as mu
doc = mu.open(sys.argv[1])
pix = doc[0].get_pixmap(alpha=False)
points = json.loads(sys.argv[2])
out = []
for x, y in points:
    px, py = int(round(x * 0.75)), int(round(y * 0.75))
    out.append(list(pix.pixel(px, py)))
print(json.dumps({"width": pix.width, "height": pix.height, "pixels": out}))
`;

function detect(): boolean {
  const probe = spawnSync('python3', ['-c', 'try:\n import pymupdf\nexcept ImportError:\n import fitz'], { encoding: 'utf8' });
  return probe.status === 0;
}

export const HAS_MUPDF = detect();
export const SKIP_WITHOUT_MUPDF = !HAS_MUPDF && process.env.ORACLE_STRICT_MODE !== '1';

export interface XpsRender {
  width: number;
  height: number;
  /** RGB at each requested point, given in XPS device-independent units from the page's top-left corner. */
  pixels: number[][];
}

export function renderXpsPoints(xps: Buffer, pointsInDips: Array<[number, number]>): XpsRender {
  if (!HAS_MUPDF) throw new Error('PyMuPDF is required by this oracle test but is not installed (ORACLE_STRICT_MODE=1)');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xps-render-'));
  try {
    const file = path.join(dir, 'in.xps');
    writeFileSync(file, xps);
    const out = execFileSync('python3', ['-c', RENDER_SCRIPT, file, JSON.stringify(pointsInDips)], { encoding: 'utf8' });
    return JSON.parse(out) as XpsRender;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
