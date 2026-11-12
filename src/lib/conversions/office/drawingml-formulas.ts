

/**
 * Evaluates an ISO/IEC 29500 DrawingML guide formula (val, mulDiv `* /`, addSub `+-`, `?:`, min, max, abs, sqrt, pin, sin, cos, tan, atan2, cat2, sat2, mod).
 */
export function evaluateDrawingMlGuideFormula(
  fmla: string,
  variables: Record<string, number>
): number {
  const tokens = fmla.trim().split(/\s+/);
  if (tokens.length === 0) return 0;
  const op = tokens[0].toLowerCase();
  const getVal = (token: string | undefined): number => {
    if (!token) return 0;
    const num = parseFloat(token);
    if (!isNaN(num)) return num;
    return variables[token] ?? 0;
  };

  switch (op) {
    case 'val':
      return getVal(tokens[1]);
    case '*/': {
      const z = getVal(tokens[3]);
      return z !== 0 ? (getVal(tokens[1]) * getVal(tokens[2])) / z : 0;
    }
    case '+-':
      return getVal(tokens[1]) + getVal(tokens[2]) - getVal(tokens[3]);
    case '?:':
      return getVal(tokens[1]) > 0 ? getVal(tokens[2]) : getVal(tokens[3]);
    case 'min':
      return Math.min(getVal(tokens[1]), getVal(tokens[2]));
    case 'max':
      return Math.max(getVal(tokens[1]), getVal(tokens[2]));
    case 'abs':
      return Math.abs(getVal(tokens[1]));
    case 'sqrt':
      return Math.sqrt(Math.max(0, getVal(tokens[1])));
    case 'pin': {
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      const z = getVal(tokens[3]);
      return Math.max(x, Math.min(y, z));
    }
    case 'sin': {
      // Angle in 60,000ths of a degree (ISO/IEC 29500: x * sin(y))
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      return x * Math.sin(y * (Math.PI / 10800000));
    }
    case 'cos': {
      // Angle in 60,000ths of a degree (ISO/IEC 29500: x * cos(y))
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      return x * Math.cos(y * (Math.PI / 10800000));
    }
    case 'tan': {
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      return x * Math.tan(y * (Math.PI / 10800000));
    }
    case 'atan2': {
      // Returns angle in 60,000ths of a degree (ISO/IEC 29500: atan2(y, x))
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      return Math.atan2(y, x) * (10800000 / Math.PI);
    }
    case 'cat2': {
      // ISO/IEC 29500: x * cos(atan2(z, y))
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      const z = getVal(tokens[3]);
      return x * Math.cos(Math.atan2(z, y));
    }
    case 'sat2': {
      // ISO/IEC 29500: x * sin(atan2(z, y))
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      const z = getVal(tokens[3]);
      return x * Math.sin(Math.atan2(z, y));
    }
    case 'mod': {
      // ISO/IEC 29500: sqrt(x^2 + y^2 + z^2)
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      const z = getVal(tokens[3]);
      return Math.hypot(x, y, z);
    }
    default:
      return getVal(tokens[1]);
  }
}

/**
 * Parses guide lists (<a:avLst>, <a:gdLst>) and evaluates guide variables sequentially with multi-pass dependency resolution.
 */
export function parseDrawingMlGuides(
  xml: string,
  initialVars: Record<string, number> = {}
): Record<string, number> {
  const vars: Record<string, number> = { ...initialVars };
  const gdRegex = /<a:gd\b[^>]*\bname="([^"]+)"[^>]*\bfmla="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  const guideDefs: Array<{ name: string; fmla: string }> = [];
  while ((match = gdRegex.exec(xml)) !== null) {
    guideDefs.push({ name: match[1], fmla: match[2] });
  }

  // Multi-pass evaluation to resolve out-of-order forward references (up to 3 passes)
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const gd of guideDefs) {
      const prev = vars[gd.name];
      const next = evaluateDrawingMlGuideFormula(gd.fmla, vars);
      if (prev !== next) {
        vars[gd.name] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return vars;
}
