import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import tailwindConfig from '../tailwind.config';

/**
 * The visual language lives in tokens: colours are CSS variables each theme defines, the radius scale is four fixed
 * steps, and shadows are a short elevation scale. These checks read every page and component source and fail when
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
    expect(allowed).toEqual(new Set(['none', 'elev-1', 'elev-2']));
    expect(outside).toEqual([]);
  });

  it('maps the radius steps to the measured values: 2.4px, 12px, 16px and 20px, with xl the largest component radius', () => {
    const steps = Object.entries(tailwindConfig.theme?.borderRadius ?? {}) as [string, string][];
    const variables = Object.fromEntries(steps.filter(([name]) => name !== 'none' && name !== 'full'));
    expect(variables).toEqual({ xs: 'var(--radius-xs)', sm: 'var(--radius-sm)', md: 'var(--radius-md)', xl: 'var(--radius-xl)' });
    const px = (name: string) => Number(new RegExp(String.raw`--radius-${name}:\s*([\d.]+)px;`).exec(globalsCss)?.[1]);
    expect(['xs', 'sm', 'md', 'xl'].map(px)).toEqual([2.4, 12, 16, 20]);
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

  it('keeps one blue primary, #2563EB, in both themes', () => {
    const accent = (selector: string) => {
      const start = globalsCss.indexOf(`${selector} {`);
      return /--c-accent:\s*([\d ]+);/.exec(globalsCss.slice(start, globalsCss.indexOf('\n}', start)))?.[1];
    };
    expect([accent(':root'), accent('.dark')]).toEqual(['37 99 235', '37 99 235']);
  });

  it('draws one sans family: no display or serif font in the tokens, the stylesheet or the sources', () => {
    expect(Object.keys(tailwindConfig.theme?.extend?.fontFamily ?? {})).toEqual(['sans']);
    expect(globalsCss).not.toMatch(/serif|--font-display/);
    expect(findAll(/\bfont-display\b|WovenGround|woven-ground/g)).toEqual([]);
    const layout = fs.readFileSync(path.join(rootDir, 'src', 'app', '[locale]', 'layout.tsx'), 'utf8');
    expect(layout.match(/localFont\(/g), 'a Latin and a Hangul file of one family').toHaveLength(2);
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

  it('keeps text on every surface at WCAG AA (4.5:1) in both themes, field borders at 3:1 and the focus ring on the canvas, a card and a sunken area at 3:1', () => {
    const block = (selector: string) => {
      const start = globalsCss.indexOf(`${selector} {`);
      return globalsCss.slice(start, globalsCss.indexOf('\n}', start));
    };
    const channels = (text: string) =>
      Object.fromEntries([...text.matchAll(/--c-([a-z0-9-]+):\s*(\d+) (\d+) (\d+);/g)].map((m) => [m[1], [Number(m[2]), Number(m[3]), Number(m[4])]]));
    const luminance = ([r, g, b]: number[]) => {
      const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const placeholderToken = /input::placeholder,\s*textarea::placeholder\s*\{[^}]*color:\s*rgb\(var\(--c-([a-z0-9-]+)\)\)/.exec(globalsCss)?.[1];
    expect(placeholderToken, 'a base rule colours the placeholder of an input and a textarea from a token').toBeDefined();
    const textOnSurface: ReadonlyArray<[string, string]> = [
      ...['ink', 'ink-2', 'ink-3', 'accent-ink', 'success', 'warning', 'danger', 'info'].flatMap((fg) =>
        ['canvas', 'surface', 'sunken'].map((bg): [string, string] => [fg, bg]),
      ),
      ...['canvas', 'surface', 'sunken'].map((bg): [string, string] => [placeholderToken!, bg]),
      ['on-accent', 'accent'],
      ['on-accent', 'accent-hover'],
      ['on-accent', 'accent-to'],
      ['on-accent', 'accent-to-hover'],
      ['accent-ink', 'accent-soft'],
      ['success', 'success-soft'],
      ['warning', 'warning-soft'],
      ['danger', 'danger-soft'],
      ['info', 'info-soft'],
    ];
    const lightFocus = /(?:^|\n)\s*:focus-visible\s*\{[^}]*outline:\s*2px solid rgb\(var\(--c-([a-z0-9-]+)\)\)/.exec(globalsCss)?.[1];
    const darkFocus = /(?:^|\n)\s*\.dark :focus-visible\s*\{[^}]*outline-color:\s*rgb\(var\(--c-([a-z0-9-]+)\)\)/.exec(globalsCss)?.[1] ?? lightFocus;
    const focusColour = { light: lightFocus, dark: darkFocus };
    const below: string[] = [];
    for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
      const tokens = channels(block(selector));
      const contrast = (fg: string, bg: string) => {
        if (!tokens[fg] || !tokens[bg]) {
          below.push(`${theme} ${fg} on ${bg}: a token is missing`);
          return Infinity;
        }
        return ratio(tokens[fg], tokens[bg]);
      };
      for (const [fg, bg] of textOnSurface) {
        const value = contrast(fg, bg);
        if (value < 4.5) below.push(`${theme} ${fg} on ${bg}: ${value.toFixed(2)}`);
      }
      for (const [fg, bg] of [
        ['rule-strong', 'canvas'],
        ['rule-strong', 'surface'],
        ...['canvas', 'surface', 'sunken'].map((surface) => [focusColour[theme] ?? 'a-missing-focus-rule', surface]),
      ]) {
        const value = contrast(fg, bg);
        if (value < 3) below.push(`${theme} ${fg} on ${bg}: ${value.toFixed(2)}`);
      }
    }
    expect(below).toEqual([]);
  });

  it('draws keyboard focus as an explicit 2px accent outline with a 2px offset on every focusable element', () => {
    const rule = /(?:^|\n)\s*:focus-visible\s*\{([^}]*)\}/.exec(globalsCss)?.[1] ?? '';
    expect(rule).toMatch(/outline:\s*2px solid rgb\(var\(--c-accent\)\)\s*;/);
    expect(rule).toMatch(/outline-offset:\s*2px\s*;/);
    const darkRule = /(?:^|\n)\s*\.dark :focus-visible\s*\{([^}]*)\}/.exec(globalsCss)?.[1] ?? '';
    expect(darkRule).toMatch(/outline-color:\s*rgb\(var\(--c-accent-ink\)\)\s*;/);
    expect(globalsCss.indexOf(':focus-visible {')).toBeGreaterThan(globalsCss.indexOf('@layer base'));
    expect(globalsCss.indexOf(':focus-visible {')).toBeLessThan(globalsCss.indexOf('@layer components'));
  });
});
