import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Oracle binaries are resolved from fixed system directories, never from a writable PATH entry. */
const ORACLE_BIN_DIRS = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/bin'];

function resolveOracleBinary(name: string): string | null {
  for (const dir of ORACLE_BIN_DIRS) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const PYTHON_BIN = resolveOracleBinary('python3');

function detect(): boolean {
  if (PYTHON_BIN === null) return false;
  const probe = spawnSync(PYTHON_BIN, ['-c', 'try:\n import pymupdf\nexcept ImportError:\n import fitz'], { encoding: 'utf8' });
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
  if (!HAS_MUPDF || PYTHON_BIN === null) {
    throw new Error('PyMuPDF is required by this oracle test but is not installed (ORACLE_STRICT_MODE=1)');
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xps-render-'));
  try {
    const file = path.join(dir, 'in.xps');
    writeFileSync(file, xps);
    const out = execFileSync(PYTHON_BIN, ['-c', RENDER_SCRIPT, file, JSON.stringify(pointsInDips)], { encoding: 'utf8' });
    return JSON.parse(out) as XpsRender;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
