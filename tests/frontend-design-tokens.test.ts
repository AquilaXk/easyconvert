import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import tailwindConfig from '../tailwind.config';
import { GROUND_DRIFT_MAX_PX, GROUND_DRIFT_RATE, groundOffset } from '../src/components/WovenGround';

/**
 * The visual language lives in tokens: colours are CSS variables each theme defines, the radius scale is a multiple
 * of one unit, and shadows are a short elevation scale. These checks read every page and component source and fail when
 * a class reaches past the tokens (a raw palette colour, an arbitrary radius, an ad-hoc shadow or a per-theme colour
 * override), so the language cannot drift one component at a time.
 */

const rootDir = path.resolve(__dirname, '..');
const UI_ROOTS = ['src/app', 'src/components'].map((dir) => path.join(rootDir, dir));
const API_ROOT = path.join(rootDir, 'src', 'app', 'api');

function uiSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== API_ROOT) uiSources(full, out);
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const sources = UI_ROOTS.flatMap((dir) => uiSources(dir)).map((file) => ({
  file: path.relative(rootDir, file),
  text: fs.readFileSync(file, 'utf8'),
}));

function findAll(pattern: RegExp): string[] {
  return sources.flatMap(({ file, text }) => [...text.matchAll(pattern)].map((m) => `${file}: ${m[0].trim()}`));
}

const COLOR_UTILITY = String.raw`(?:bg|text|border(?:-[trblxy])?|divide|ring(?:-offset)?|outline|placeholder|accent|caret|decoration|fill|stroke|from|via|to)`;
const LEGACY_PALETTE = String.raw`(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black|brand|primary|dark|status|ink-(?:primary|secondary|muted))`;
const CLASS_START = String.raw`(?<=^|[\s"'\x60{])(?:[a-z0-9-]+:)*!?`;
const RAW_HEX = /(?<![&\w])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;
/** Third-party marks whose owners fix their colours: the Google sign-in "G". */
const MARK_COLOURS: Record<string, readonly string[]> = {
  [path.join('src', 'components', 'auth', 'AuthForms.tsx')]: ['#4285F4', '#34A853', '#FBBC05', '#EA4335'],
};
const globalsCss = fs.readFileSync(path.join(rootDir, 'src', 'app', 'globals.css'), 'utf8');

describe('design tokens', () => {
  it('reads a non-empty set of page and component sources', () => {
    expect(sources.length).toBeGreaterThan(40);
    expect(sources.some(({ file }) => file.startsWith(path.join('src', 'app', 'api') + path.sep))).toBe(false);
  });

  it('uses only token colours: no raw palette, hex or rgb colour classes', () => {
    const raw = findAll(new RegExp(String.raw`${CLASS_START}${COLOR_UTILITY}-(?:${LEGACY_PALETTE}(?:-\d+)?|\[(?:#|rgb|hsl))[^\s"'\x60}]*`, 'g'));
    expect(raw).toEqual([]);
  });

  it('keeps one palette for both themes: no dark: colour overrides', () => {
    expect(findAll(new RegExp(String.raw`${CLASS_START.replace('(?:[a-z0-9-]+:)*', '')}dark:(?:[a-z-]+:)*${COLOR_UTILITY}-[^\s"'\x60}]+`, 'g'))).toEqual([]);
  });

  it('draws radii only from the scale: no arbitrary rounded-[...] class or inline border radius', () => {
    expect(findAll(new RegExp(String.raw`${CLASS_START}rounded(?:-[trblse]{1,2})?-\[[^\]]*\]`, 'g'))).toEqual([]);
    expect(findAll(/borderRadius\s*:/g)).toEqual([]);
  });

  it('draws shadows only from the elevation tokens', () => {
    const allowed = new Set(Object.keys(tailwindConfig.theme?.boxShadow ?? {}));
    const used = findAll(new RegExp(String.raw`${CLASS_START}shadow(?:-[a-z0-9-]+)?(?=[\s"'\x60}]|$)`, 'g'));
    const outside = used.filter((hit) => {
      const cls = hit.slice(hit.indexOf(': ') + 2);
      const name = cls.slice(cls.lastIndexOf(':') + 1).replace(/^!?shadow-?/, '');
      return !allowed.has(name);
    });
    expect(allowed).toEqual(new Set(['none', 'elev-1', 'elev-2', 'glow', 'float']));
    expect(outside).toEqual([]);
  });

  it('maps every radius step to a multiple of the 0.1rem unit, with xl the largest component radius', () => {
    const steps = Object.entries(tailwindConfig.theme?.borderRadius ?? {}) as [string, string][];
    const units = Object.fromEntries(
      steps
        .filter(([name]) => name !== 'none' && name !== 'full')
        .map(([name, value]) => [name, Number(/^calc\(var\(--radius-unit\) \* ([\d.]+)\)$/.exec(value)?.[1])]),
    );
    expect(units).toEqual({ xs: 0.5, sm: 1, md: 1.5, xl: 3 });
    const largest = Object.entries(units).reduce((max, step) => (step[1] > max[1] ? step : max));
    expect(largest[0]).toBe('xl');
    expect(globalsCss).toMatch(/--radius-unit:\s*0\.1rem;/);
  });

  it('rejects the retired radius and shadow steps, a bare rounded class and raw hex colours', () => {
    // Class names live in string literals; identifiers such as a `rounded` variable are not classes.
    const retired = /^(?:shadow-(?:sm|md|lg)|rounded(?:-[trblse]{1,2})?(?:-(?:lg|2xl|3xl))?)$/;
    const retiredClasses = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/"[^"\n]*"|'[^'\n]*'|\x60[^\x60]*\x60/g)]
        .flatMap((literal) => literal[0].slice(1, -1).split(/\s+/))
        .filter((token) => retired.test(token.replace(/^(?:[a-z0-9-]+:)*!?/, '')))
        .map((token) => `${file}: ${token}`),
    );
    expect(retiredClasses).toEqual([]);
    const hex = sources.flatMap(({ file, text }) =>
      [...text.matchAll(RAW_HEX)]
        .map((m) => m[0].toUpperCase())
        .filter((colour) => !(MARK_COLOURS[file] ?? []).includes(colour))
        .map((colour) => `${file}: ${colour}`),
    );
    expect(hex).toEqual([]);
  });

  it('gives every hover class a change: no hover that repeats the resting class beside it', () => {
    // One class list is a quoted string or a static run of a template literal; the arms of a ternary are separate lists.
    const classLists = (text: string) =>
      [...text.matchAll(/"[^"\n]*"|'[^'\n]*'|\x60[^\x60]*\x60/g)].flatMap((literal) => literal[0].slice(1, -1).split(/\$\{|\}|'|"/));
    const noOps = sources.flatMap(({ file, text }) =>
      classLists(text).flatMap((list) => {
        const tokens = new Set(list.split(/\s+/));
        return [...tokens].filter((token) => token.startsWith('hover:') && tokens.has(token.slice('hover:'.length))).map((token) => `${file}: ${token}`);
      }),
    );
    expect(noOps).toEqual([]);
  });

  it('keeps the signature accent #5C6BC0 in both themes, the colour of the static brand files', () => {
    const accent = (selector: string) => {
      const start = globalsCss.indexOf(`${selector} {`);
      return /--c-accent:\s*([\d ]+);/.exec(globalsCss.slice(start, globalsCss.indexOf('\n}', start)))?.[1];
    };
    expect([accent(':root'), accent('.dark')]).toEqual(['92 107 192', '92 107 192']);
  });

  it('drifts the woven ground no further than the layer extends below the viewport, on both scroll paths', () => {
    expect([0, 600, 1200, 5000, 40000].map(groundOffset)).toEqual([0, 120, 240, 240, 240]);
    expect(groundOffset(-80)).toBe(0);
    const ground = /\.woven-ground \{[^}]*inset: 0 0 -(\d+)px 0;/.exec(globalsCss)?.[1];
    const drift = /@keyframes ground-drift \{\s*to \{\s*transform: translate3d\(0, -(\d+)px, 0\);/.exec(globalsCss)?.[1];
    const range = /animation-range: 0 (\d+)px;/.exec(globalsCss)?.[1];
    expect([Number(ground), Number(drift), Number(range)]).toEqual([GROUND_DRIFT_MAX_PX, GROUND_DRIFT_MAX_PX, GROUND_DRIFT_MAX_PX / GROUND_DRIFT_RATE]);
  });

  it('defines every colour token for both themes', () => {
    const css = globalsCss;
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf('\n}', start));
    };
    const declared = (text: string) => new Set([...text.matchAll(/--c-([a-z0-9-]+):/g)].map((m) => m[1]));
    const tokenNames = JSON.stringify(tailwindConfig.theme?.colors).match(/--c-[a-z0-9-]+/g)?.map((name) => name.slice(4)) ?? [];

    expect(tokenNames.length).toBeGreaterThan(20);
    expect(tokenNames.filter((name) => !declared(block(':root')).has(name))).toEqual([]);
    expect(tokenNames.filter((name) => !declared(block('.dark')).has(name))).toEqual([]);
  });
});
