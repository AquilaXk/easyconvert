import { describe, expect, it } from 'vitest';
import { CorruptStreamError, PayloadLimitError } from '../src/lib/types';
import { expectNoHang } from './helpers/timing';
import { requirePagesDrawable, XPS_MAX_REPEATED_BYTES } from '../src/lib/conversions/office/xps-resources';

/**
 * What a page costs when the resources it uses use other resources, and how the renderer reads the names of the parts. Each
 * expected count below is worked out by hand from the markup and stated beside it; the renderer is the oracle for the two
 * behaviours that matter. GhostXPS 10.08.0 resolves a `{StaticResource key}` while it parses the entry the key names, so a
 * brush an entry holds is parsed (and its image decoded) once for each use of the entry (GhostPDL xps/xpsresource.c
 * `xps_parse_resource_reference`, `xps_find_resource`, read for behaviour only). A VisualBrush `A` whose Visual `V` holds a
 * path that fills with `A` never ends: the unchanged package drew in under a second (exit 0) and the one with the loop
 * crashed the program (exit 139, the stack) when run through `gxps -sDEVICE=pdfwrite`.
 */

const NS = 'http://schemas.microsoft.com/xps/2005/06';
const X = 'http://schemas.microsoft.com/winfx/2006/xaml';
const MEBIBYTE = 1024 * 1024;
const IMAGE_PART = 'resources/big.bin';
const TIMEOUT_MS = 120_000;
/** Neither an image nor a profile the header reader knows, so a part of this size costs its bytes and no pixels. */
const OPAQUE = Buffer.alloc(MEBIBYTE);
/** The uses of the one-mebibyte part that fill the byte budget exactly. */
const USES_AT_BUDGET = XPS_MAX_REPEATED_BYTES / MEBIBYTE;
const CORRUPT_PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('this is not a png chunk', 'latin1')]);

function page(body: string, resources = ''): string {
  return `<FixedPage xmlns="${NS}" xmlns:x="${X}" Width="816" Height="1056">${resources}${body}</FixedPage>`;
}

function dictionary(entries: string): string {
  return `<ResourceDictionary xmlns="${NS}" xmlns:x="${X}">${entries}</ResourceDictionary>`;
}

const imageBrush = (key: string, source = `/${IMAGE_PART}`): string => `<ImageBrush x:Key="${key}" ImageSource="${source}" Viewbox="0,0,1,1" Viewport="0,0,1,1"/>`;
/** An entry that draws `count` paths, each filled with the entry `used`. */
const canvasUsing = (key: string, used: string, count: number): string => `<Canvas x:Key="${key}">${path(used, count)}</Canvas>`;
const path = (used: string, count: number): string => `<Path Data="M 0,0 L 1,0 1,1 Z" Fill="{StaticResource ${used}}"/>`.repeat(count);

async function outcome(pages: readonly string[], parts: Record<string, Buffer | string>): Promise<'drawn' | Error> {
  const held = new Map<string, Buffer>();
  const names: string[] = [];
  pages.forEach((text, index) => {
    names.push(`pages/${index + 1}.fpage`);
    held.set(`pages/${index + 1}.fpage`, Buffer.from(text));
  });
  for (const [name, bytes] of Object.entries(parts)) held.set(name.toLowerCase(), Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return requirePagesDrawable(names, held, TIMEOUT_MS).then(
    () => 'drawn' as const,
    (error: unknown) => error as Error,
  );
}

function expectRefusedForBytes(result: 'drawn' | Error): void {
  expect(result).toBeInstanceOf(PayloadLimitError);
  expect((result as Error).message).toMatch(/bytes of images and colour profiles/);
}

describe('a resource that uses another resource', () => {
  // Hand count: the page fills 16 paths with B; B holds 32 paths that fill with A; A is one brush of the 1 MiB part.
  // 16 x 32 = 512 decodes of 1 MiB = 512 MiB, the budget; one more path in B makes 16 x 33 = 528 MiB. A dictionary part is itself
  // charged once (its bytes), so with it 32 paths in B are already over the budget and 31 (496 MiB) are not.
  const PAGE_USES = 16;
  const NESTED_USES_AT_BUDGET = USES_AT_BUDGET / PAGE_USES;

  it.each([
    [
      'a dictionary part',
      (entries: string) => ({
        page: page(path('B', PAGE_USES), '<FixedPage.Resources><ResourceDictionary Source="/resources/shared.dict"/></FixedPage.Resources>'),
        parts: { 'resources/shared.dict': dictionary(entries) },
      }),
      NESTED_USES_AT_BUDGET - 1,
    ],
    ['a dictionary in the page', (entries: string) => ({ page: page(path('B', PAGE_USES), `<FixedPage.Resources>${dictionary(entries)}</FixedPage.Resources>`), parts: {} }), NESTED_USES_AT_BUDGET],
  ])('is charged for every use of the entry that uses it, in %s', async (_label, build, fits) => {
    const at = build(imageBrush('A') + canvasUsing('B', 'A', fits));
    expect(await outcome([at.page], { [IMAGE_PART]: OPAQUE, ...at.parts })).toBe('drawn');
    const over = build(imageBrush('A') + canvasUsing('B', 'A', fits + 1));
    expectRefusedForBytes(await outcome([over.page], { [IMAGE_PART]: OPAQUE, ...over.parts }));
  });

  it('is charged through three levels: 8 uses of C, each use of C draws 8 of B, each of B draws 8 of A, is 512 decodes', async () => {
    const entries = (innermost: number) => imageBrush('A') + canvasUsing('B', 'A', innermost) + canvasUsing('C', 'B', 8);
    const resources = (innermost: number) => `<FixedPage.Resources>${dictionary(entries(innermost))}</FixedPage.Resources>`;
    expect(await outcome([page(path('C', 8), resources(8))], { [IMAGE_PART]: OPAQUE })).toBe('drawn');
    expectRefusedForBytes(await outcome([page(path('C', 8), resources(9))], { [IMAGE_PART]: OPAQUE }));
  });

  it('is charged for the uses of an entry by each of two entries that use it: B and C draw A 256 times each, the page uses both once', async () => {
    const entries = (uses: number) => imageBrush('A') + canvasUsing('B', 'A', uses) + canvasUsing('C', 'A', uses);
    const resources = (uses: number) => `<FixedPage.Resources>${dictionary(entries(uses))}</FixedPage.Resources>`;
    expect(await outcome([page(path('B', 1) + path('C', 1), resources(USES_AT_BUDGET / 2))], { [IMAGE_PART]: OPAQUE })).toBe('drawn');
    expectRefusedForBytes(await outcome([page(path('B', 1) + path('C', 1), resources(USES_AT_BUDGET / 2 + 1))], { [IMAGE_PART]: OPAQUE }));
  });

  it('is charged for a use that sits in an element deeper inside the entry, not only on its root', async () => {
    const deep = (uses: number) => `<Canvas x:Key="B"><Canvas><Canvas.RenderTransform><MatrixTransform Matrix="1,0,0,1,0,0"/></Canvas.RenderTransform>${path('A', uses)}</Canvas></Canvas>`;
    const resources = (uses: number) => `<FixedPage.Resources>${dictionary(imageBrush('A') + deep(uses))}</FixedPage.Resources>`;
    expect(await outcome([page(path('B', PAGE_USES), resources(USES_AT_BUDGET / PAGE_USES))], { [IMAGE_PART]: OPAQUE })).toBe('drawn');
    expectRefusedForBytes(await outcome([page(path('B', PAGE_USES), resources(USES_AT_BUDGET / PAGE_USES + 1))], { [IMAGE_PART]: OPAQUE }));
  });

  it('does not read an image that only an entry nobody uses names, however it is nested', async () => {
    const resources = `<FixedPage.Resources>${dictionary(imageBrush('A', '/resources/bad.png') + canvasUsing('B', 'A', 1))}</FixedPage.Resources>`;
    expect(await outcome([page(path('Other', 1), resources)], { 'resources/bad.png': CORRUPT_PNG })).toBe('drawn');
  });

  it('reads an image through a used chain of entries, and refuses it when its header cannot be read', async () => {
    const resources = `<FixedPage.Resources>${dictionary(imageBrush('A', '/resources/bad.png') + canvasUsing('B', 'A', 1))}</FixedPage.Resources>`;
    const result = await outcome([page(path('B', 1), resources)], { 'resources/bad.png': CORRUPT_PNG });
    expect(result).not.toBe('drawn');
    expect((result as Error).message).toMatch(/Invalid image: the header could not be decoded/);
  });
});

describe('hostile nesting of resources', () => {
  it('refuses a fan-out bomb at once: 60 entries that each use the next 4 times ask for 4^60 decodes of the last', async () => {
    const LEVELS = 60;
    let entries = imageBrush('K60');
    for (let level = LEVELS - 1; level >= 0; level -= 1) entries += canvasUsing(`K${level}`, `K${level + 1}`, 4);
    const result = await expectNoHang('fan-out of nested resource uses', () => outcome([page(path('K0', 1), `<FixedPage.Resources>${dictionary(entries)}</FixedPage.Resources>`)], { [IMAGE_PART]: OPAQUE }));
    expectRefusedForBytes(result);
  });

  it('refuses a fan-out bomb whose last entry names an empty-looking part (the product is capped, not carried into NaN)', async () => {
    const LEVELS = 1_100;
    let entries = imageBrush('K1100', '/resources/empty.bin');
    for (let level = LEVELS - 1; level >= 0; level -= 1) entries += canvasUsing(`K${level}`, `K${level + 1}`, 2);
    const result = await outcome([page(path('K0', 1), `<FixedPage.Resources>${dictionary(entries)}</FixedPage.Resources>`)], { 'resources/empty.bin': Buffer.alloc(0) });
    expectRefusedForBytes(result);
  });

  it('reads a chain of 5,000 entries that each use the next once, without a call per level, and charges the last image once', async () => {
    const LEVELS = 5_000;
    let entries = imageBrush(`K${LEVELS}`);
    for (let level = LEVELS - 1; level >= 0; level -= 1) entries += canvasUsing(`K${level}`, `K${level + 1}`, 1);
    const resources = `<FixedPage.Resources>${dictionary(entries)}</FixedPage.Resources>`;
    // One use of the chain is one decode: the page can use it as often as the budget allows, and one more is over.
    expect(await outcome([page(path('K0', USES_AT_BUDGET), resources)], { [IMAGE_PART]: OPAQUE })).toBe('drawn');
    expectRefusedForBytes(await outcome([page(path('K0', USES_AT_BUDGET + 1), resources)], { [IMAGE_PART]: OPAQUE }));
  });

  it('refuses entries that use each other in a loop (the renderer crashes on it), and one that uses itself', async () => {
    const loop = `<FixedPage.Resources>${dictionary(canvasUsing('A', 'B', 1) + canvasUsing('B', 'A', 1) + imageBrush('I'))}</FixedPage.Resources>`;
    const own = `<FixedPage.Resources>${dictionary(canvasUsing('A', 'A', 1))}</FixedPage.Resources>`;
    for (const resources of [loop, own]) {
      const result = await outcome([page(path('A', 1), resources)], {});
      expect(result).toBeInstanceOf(CorruptStreamError);
      expect((result as Error).message).toMatch(/resource "A", which is part of a loop/);
    }
  });

  it('does not refuse a loop of entries that nothing on the page uses', async () => {
    const resources = `<FixedPage.Resources>${dictionary(canvasUsing('A', 'B', 1) + canvasUsing('B', 'A', 1))}</FixedPage.Resources>`;
    expect(await outcome([page(path('Other', 1), resources)], {})).toBe('drawn');
  });
});

describe('hostile reach of the keys of a page', () => {
  it('refuses pages that each reach a long chain of entries, before the pages have read the whole of it again and again', async () => {
    // Hand count: 60 entries are reached by each page (K0 uses K1 ... K59 uses K60, no image); 10,000 pages reach 600,000 > 524,288 entries.
    const LEVELS = 60;
    let entries = '';
    for (let level = 0; level < LEVELS; level += 1) entries += canvasUsing(`K${level}`, `K${level + 1}`, 1);
    entries += canvasUsing(`K${LEVELS}`, 'Nothing', 1);
    const pages = Array.from({ length: 10_000 }, () => page(path('K0', 1), `<FixedPage.Resources>${dictionary(entries)}</FixedPage.Resources>`));
    const result = await outcome(pages, {});
    expect(result).toBeInstanceOf(PayloadLimitError);
    expect((result as Error).message).toMatch(/entries of resource dictionaries/);
  });

  it('refuses one page that reaches more entries than the budget holds, with no image named at all', async () => {
    const LEVELS = 530_000;
    const parts: string[] = [];
    for (let level = 0; level < LEVELS; level += 1) parts.push(`<Canvas x:Key="K${level}"><Path Fill="{StaticResource K${level + 1}}"/></Canvas>`);
    const result = await outcome([page(path('K0', 1), `<FixedPage.Resources>${dictionary(parts.join(''))}</FixedPage.Resources>`)], {});
    expect(result).toBeInstanceOf(PayloadLimitError);
    expect((result as Error).message).toMatch(/page reaches more than 524288 entries/);
  }, 60_000);
});

describe('the names of the parts a page gives', () => {
  // Oracle: xps_absolute_path (GhostPDL xps/xpsmem.c lines 60 to 132) joins and cleans the name and does not decode it, so
  // `p%20q.icc` is a part of that name, found only when the package holds a part called so.
  const profileFill = (name: string): string => `<Path Data="M 0,0 L 1,0 1,1 Z" Fill="ContextColor ${name} 1,0.5,0.2"/>`;
  const PAGES = USES_AT_BUDGET + 1;

  it.each([
    ['a percent sign, which is not decoded', '/resources/p%20q.icc', 'resources/p%20q.icc', true],
    ['a percent-encoded name for a part named with a space', '/resources/p%20q.icc', 'resources/p q.icc', false],
    ['a name with .. above the root, which stays at the root', '/../resources/p.icc', 'resources/p.icc', true],
    ['a relative name with a . and a .. element', 'a/./../resources/p.icc', 'pages/resources/p.icc', true],
    ['a relative name that goes up out of the page folder', '../resources/p.icc', 'resources/p.icc', true],
  ])('names a colour profile with %s', async (_label, name, partName, found) => {
    const pages = Array.from({ length: PAGES }, () => page(profileFill(name)));
    expect(await outcome(pages, { [partName]: OPAQUE })).toSatisfy((result: unknown) => (found ? result instanceof PayloadLimitError : result === 'drawn'));
  });

  it('names a font and a resource dictionary Source the same way, and charges a font once', async () => {
    const fonts = Array.from({ length: PAGES }, (_unused, index) => page(`<Glyphs FontUri="/fonts/f%20${index}.ttf" FontRenderingEmSize="10" OriginX="1" OriginY="1" UnicodeString="x"/>`));
    const fontParts = Object.fromEntries(fonts.map((_text, index) => [`fonts/f%20${index}.ttf`, OPAQUE]));
    expectRefusedForBytes(await outcome(fonts, fontParts));
    const faces = fonts.map((text) => text.replace(/\.ttf"/, '.ttf#1"'));
    expectRefusedForBytes(await outcome(faces, fontParts));
    const decoded = Object.fromEntries(fonts.map((_text, index) => [`fonts/f ${index}.ttf`, OPAQUE]));
    expect(await outcome(fonts, decoded)).toBe('drawn');

    const source = page(path('A', PAGES), '<FixedPage.Resources><ResourceDictionary Source="dicts/a%20b.dict"/></FixedPage.Resources>');
    const parts = { [IMAGE_PART]: OPAQUE, 'pages/dicts/a%20b.dict': dictionary(imageBrush('A')) };
    expectRefusedForBytes(await outcome([source], parts));
    expect(await outcome([source], { [IMAGE_PART]: OPAQUE, 'pages/dicts/a b.dict': dictionary(imageBrush('A')) })).toBe('drawn');
  });
});
