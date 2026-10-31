import { ConversionFailedError, CorruptStreamError } from '../types';
import { chunkAt, idAt, visitChunksStartingWith, type Chunk, type DjvuBundle } from './djvu-container';
import type { DjvuDirectoryEntry } from './djvu-report';

/**
 * The files a page of a bundled document includes, and the files those include in turn, checked before `ddjvu` starts.
 *
 * A page names shared data in `INCL` chunks (libdjvu/DjVuFile.cpp `process_incl_chunks`, lines 680 to 741, and
 * `process_incl_chunk`, lines 545 to 640): the chunk holds a name, with the newlines at its ends removed, an empty name
 * names nothing and a name with a slash, a backslash or a colon is an error. `DjVuDocument::id_to_url` (libdjvu/DjVuDocument.cpp
 * lines 794 to 847) finds the file of a bundle by the name as an id, then as a name, then as a title. The program creates
 * the files a file names when it decodes it, and a file that is included from two files is created again for each of them
 * as far as the time it takes shows: a chain of includes that each name the next two files makes a document of 2,346 bytes
 * (the shape `poc_f.py 40` writes) that takes `ddjvu` over a minute, and each level more doubles it. `djvused -e 'n;ls'` reads
 * the directory alone, so the directory it reports can be read before the graph; `djvused -e size` opens the pages and the
 * files they include, and crashes on a cycle and on a chain thousands of files deep (djvu-report.ts), so it runs after.
 *
 * The graph is read from the bytes, in one pass over the chunks of each file of the directory (a file the directory lists
 * twice is read once): the edges are the `INCL` names, resolved against the ids, names and titles that `djvused` lists for
 * the files, and the files are found by the offsets of the directory, as the program finds them. A name that no file of the
 * directory carries is no edge: the program has nothing to load for it. The graph is refused when
 *  - it has a cycle (the program would load without end);
 *  - a page reaches shared data more than `DJVU_MAX_INCLUDE_DEPTH` files deep (a document written by djvulibre has one level:
 *    `wc-dogv-12042005.djvu` includes a dictionary in each page);
 *  - it has more than `DJVU_MAX_INCLUDE_EDGES` edges;
 *  - the pages would load more than `DJVU_MAX_INCLUDE_LOADS` files, counted as the program loads them, once for each path.
 */

/** Includes below a page. Real documents have one level; a shared annotation file or a dictionary of dictionaries makes two. */
export const DJVU_MAX_INCLUDE_DEPTH = 4;
/** `INCL` chunks of a document: a real page names one or two files, so this is far above the 10,000 pages and below any cost. */
export const DJVU_MAX_INCLUDE_EDGES = 100_000;
/**
 * Files the pages of a document load, counted for each path to them. `ddjvu` loads about 4.4 million a second of an empty
 * include (`poc_f 30` is 2,178,308 loads in 0.51 s, `poc_f 33` 9,227,464 in 2.06 s, `poc_f 40` 267,914,295; djvulibre 3.5.29
 * on Apple silicon), so this is a quarter of a second and fifty times what a document of 10,000 pages with two includes each
 * needs.
 */
export const DJVU_MAX_INCLUDE_LOADS = 1_000_000;

const FORM = 'FORM';
const THUMBNAILS_FORM = 'THUM';
const FORM_TYPE_BYTES = 4;
const INCL = 'INCL';
const FIRST_BYTE_I = 0x49;
const NEWLINE_BYTE = 0x0a;
const FORBIDDEN_IN_NAME = /[/\\:]/;
const NAME_DECODER = new TextDecoder('utf-8');

export class DjvuIncludeGraphError extends ConversionFailedError {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'DjvuIncludeGraphError';
  }
}

interface Component {
  readonly form: Chunk;
  readonly type: string;
}

/** The `FORM` that a directory offset points at; the directory's own sizes are not trusted, the chunk must fit the bundle. */
function componentAt(bytes: Uint8Array, offset: number, end: number): Component {
  const form = chunkAt(bytes, offset, end);
  if (form.id !== FORM || form.end - form.start < FORM_TYPE_BYTES) throw new CorruptStreamError('The DjVu file is damaged: a file of the directory is not a FORM chunk.');
  return { form, type: idAt(bytes, form.start) };
}

/** The name an `INCL` chunk holds as the program reads it, or undefined for a chunk that names no file. */
function includedName(bytes: Uint8Array, start: number, end: number): string | undefined {
  let from = start;
  let to = end;
  while (from < to && bytes[from] === NEWLINE_BYTE) from++;
  while (to > from && bytes[to - 1] === NEWLINE_BYTE) to--;
  if (from === to) return undefined;
  const name = NAME_DECODER.decode(bytes.subarray(from, to));
  return FORBIDDEN_IN_NAME.test(name) ? undefined : name;
}

function readNames(bytes: Uint8Array, component: Component, budget: { chunks: number }): readonly string[] {
  const names = new Set<string>();
  visitChunksStartingWith(bytes, component.form, [FIRST_BYTE_I], (id, start, end) => {
    if (id !== INCL) return;
    if (++budget.chunks > DJVU_MAX_INCLUDE_EDGES) throw new DjvuIncludeGraphError(`The DjVu document has more than ${DJVU_MAX_INCLUDE_EDGES} include chunks.`);
    const name = includedName(bytes, start, end);
    if (name !== undefined) names.add(name);
  });
  return [...names];
}

/** The nodes of the graph are the distinct offsets; the entries of the directory that are not thumbnails are laid on the offsets in order. */
interface Layout {
  readonly components: Component[];
  /** The node of each entry of `ls`, with the entry. */
  readonly listed: { node: number; entry: DjvuDirectoryEntry }[];
}

function directoryMismatch(): CorruptStreamError {
  return new CorruptStreamError('The DjVu file is damaged: the files of its directory and the chunks they point at do not agree.');
}

function layoutOf(bytes: Uint8Array, bundle: DjvuBundle, directory: readonly DjvuDirectoryEntry[]): Layout {
  const components: Component[] = [];
  const nodeOfOffset = new Map<number, number>();
  const listed: Layout['listed'] = [];
  let next = 0;
  for (const offset of bundle.offsets) {
    let node = nodeOfOffset.get(offset);
    if (node === undefined) {
      node = components.length;
      components.push(componentAt(bytes, offset, bundle.end));
      nodeOfOffset.set(offset, node);
    }
    if (components[node].type === THUMBNAILS_FORM) continue;
    if (next >= directory.length) throw directoryMismatch();
    listed.push({ node, entry: directory[next++] });
  }
  if (next !== directory.length) throw directoryMismatch();
  return { components, listed };
}

type NameTable = Map<string, Set<number>>;
const NO_TARGETS: ReadonlySet<number> = new Set();

function addName(table: NameTable, name: string, node: number): void {
  const nodes = table.get(name);
  if (nodes === undefined) table.set(name, new Set([node]));
  else nodes.add(node);
}

/** The files a name may stand for, in the order the program looks: as an id, as a name, as a title. */
function nameTables(listed: Layout['listed']): readonly [NameTable, NameTable, NameTable] {
  const tables: [NameTable, NameTable, NameTable] = [new Map(), new Map(), new Map()];
  for (const { node, entry } of listed) {
    for (const id of entry.ids) addName(tables[0], id, node);
    for (const name of entry.names) addName(tables[1], name, node);
    for (const title of entry.titles) addName(tables[2], title, node);
  }
  return tables;
}

function targetsOf(name: string, tables: readonly NameTable[]): ReadonlySet<number> {
  for (const table of tables) {
    const nodes = table.get(name);
    if (nodes !== undefined) return nodes;
  }
  return NO_TARGETS;
}

function edgesOf(bytes: Uint8Array, layout: Layout): number[][] {
  const tables = nameTables(layout.listed);
  const budget = { chunks: 0 };
  let edges = 0;
  return layout.components.map((component) => {
    const targets = new Set<number>();
    for (const name of readNames(bytes, component, budget)) for (const node of targetsOf(name, tables)) targets.add(node);
    edges += targets.size;
    if (edges > DJVU_MAX_INCLUDE_EDGES) throw new DjvuIncludeGraphError(`The DjVu document has more than ${DJVU_MAX_INCLUDE_EDGES} edges between its files.`);
    return [...targets];
  });
}

/** A count of loads stops growing one past the limit once the page's own file is taken off, so that a huge count cannot grow without end and still tests as over. */
const LOADS_SATURATION = DJVU_MAX_INCLUDE_LOADS + 2;
const NEW = 0;
const OPEN = 1;
const DONE = 2;

/** Walks the include graph from the pages, once for each file: the height of every file below the first page that reaches it, and the loads one page makes. */
class IncludeWalk {
  private readonly state: number[];
  private readonly height: number[];
  private readonly loads: number[];

  constructor(private readonly edges: readonly number[][]) {
    this.state = edges.map(() => NEW);
    this.height = edges.map(() => 0);
    this.loads = edges.map(() => 1);
  }

  /** Loads of a page: the files below it, counted for each path. */
  loadsOf(node: number): number {
    this.visit(node, 0);
    return this.loads[node] - 1;
  }

  private visit(node: number, depth: number): void {
    if (this.state[node] === OPEN) throw new DjvuIncludeGraphError('The DjVu document includes shared data that includes itself (an include cycle).');
    if (this.state[node] === DONE) return this.checkDepth(depth + this.height[node]);
    this.checkDepth(depth);
    this.state[node] = OPEN;
    let height = 0;
    let loads = 1;
    for (const child of this.edges[node]) {
      this.visit(child, depth + 1);
      height = Math.max(height, this.height[child] + 1);
      loads = Math.min(loads + this.loads[child], LOADS_SATURATION);
    }
    this.height[node] = height;
    this.loads[node] = loads;
    this.state[node] = DONE;
  }

  private checkDepth(depth: number): void {
    if (depth > DJVU_MAX_INCLUDE_DEPTH) throw new DjvuIncludeGraphError(`The DjVu document includes shared data more than ${DJVU_MAX_INCLUDE_DEPTH} files deep.`);
  }
}

/**
 * Refuses a bundled document whose include graph is a cycle, is deeper than `DJVU_MAX_INCLUDE_DEPTH`, has more than
 * `DJVU_MAX_INCLUDE_EDGES` edges, or would make the program load more than `DJVU_MAX_INCLUDE_LOADS` files. `directory` is the
 * listing of `djvused` (djvu-report.ts).
 */
export function checkIncludeGraph(bytes: Uint8Array, bundle: DjvuBundle, directory: readonly DjvuDirectoryEntry[]): void {
  const layout = layoutOf(bytes, bundle, directory);
  const walk = new IncludeWalk(edgesOf(bytes, layout));
  let loads = 0;
  for (const { node, entry } of layout.listed) {
    if (!entry.page) continue;
    loads += walk.loadsOf(node);
    if (loads > DJVU_MAX_INCLUDE_LOADS) throw new DjvuIncludeGraphError(`The pages of the DjVu document would load more than ${DJVU_MAX_INCLUDE_LOADS} shared files.`);
  }
}
