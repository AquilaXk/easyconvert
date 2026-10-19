import fs from 'node:fs';
import path from 'node:path';
import { PdfPostprocessError } from '../../types';
import { runQpdf, runQpdfToBuffer, withQpdfWorkspace, type QpdfWorkspace } from './qpdf-run';

/**
 * Mending a page tree that reaches one of its own nodes a second time.
 *
 * qpdf, and every tool built on its page model, walks /Pages once and stops at "Loop detected in /Pages structure" when a
 * node of the tree comes back through /Kids, so the page operations and `qpdf --check` refuse the document although its
 * pages are intact. Only the edge that closes the loop is wrong: dropping every /Kids entry that names a /Pages node
 * already placed in the tree leaves each page where it was and makes the tree a tree. A /Pages node left without a page
 * is dropped from its parent, and the /Count of every node on the way is the number of pages below it.
 *
 * The walk claims a node when its parent lists it, so it visits each node once however the references loop: it is bounded
 * by the number of objects in the file, and it keeps no recursion, so a chain of any length cannot exhaust the stack.
 */

type JsonDictionary = Record<string, unknown>;

/** An indirect object as `qpdf --json` writes it (version 2): a value, or a stream with its dictionary. */
export interface PdfJsonObject {
  value?: JsonDictionary;
  stream?: { dict: JsonDictionary };
}

/** The objects of `qpdf --json=2 --json-key=qpdf`, keyed `obj:N G R`, with the `trailer` entry. */
export type PdfJsonObjects = Readonly<Record<string, PdfJsonObject>>;

const KIDS = '/Kids';
const COUNT = '/Count';
const PAGES = '/Pages';
const ROOT = '/Root';
const OBJECT_KEY_PREFIX = 'obj:';
/** An indirect reference in qpdf's JSON: `12 0 R`. A string value of the document is written `u:...`, so it never matches. */
const REFERENCE = /^\d+ \d+ R$/;
/** The version of the JSON format qpdf reads and writes here. */
const JSON_VERSION = 2;
const UPDATE_FILE = 'page-tree.json';
/**
 * Most bytes of the object export that are read. The export lists every object with its dictionary and is parsed whole, and
 * packed object streams expand it far past the size of the file, so it has a limit of its own and not the output limit of a
 * rewrite. Measured on the 43 PDFs of the pdf-ops corpus the export is 0.5 to 3.4 times the file (largest: 2.4 MB, from a
 * 0.7 MB tagged form); 32 MiB is 13 times that largest export and holds the page-tree objects of a document of about 10 MB.
 */
const PAGE_TREE_EXPORT_LIMIT_BYTES = 32 * 1024 * 1024;
/** Lists the objects of the document as JSON, without the data of their streams. */
const EXPORT_ARGS: readonly string[] = [`--json=${JSON_VERSION}`, '--json-key=qpdf', '--json-stream-data=none'];

const isReference = (value: unknown): value is string => typeof value === 'string' && REFERENCE.test(value);

function dictionaryOf(objects: PdfJsonObjects, reference: unknown): JsonDictionary | undefined {
  return isReference(reference) ? objects[`${OBJECT_KEY_PREFIX}${reference}`]?.value : undefined;
}

/** The dictionary of an intermediate node of the page tree: an object whose /Kids is an array. */
function treeNode(objects: PdfJsonObjects, reference: unknown): JsonDictionary | undefined {
  const dictionary = dictionaryOf(objects, reference);
  return Array.isArray(dictionary?.[KIDS]) ? dictionary : undefined;
}

interface TreeNode {
  reference: string;
  dictionary: JsonDictionary;
}

interface Placed extends TreeNode {
  /** The /Kids entries that stay: every one that does not name a node placed before. */
  kids: unknown[];
}

/** Places every node of the tree below `root` once, parents before their children and, among the kids of a node, in the order it lists them. */
function placeNodes(objects: PdfJsonObjects, root: string, rootDictionary: JsonDictionary): Placed[] {
  const claimed = new Set<string>([root]);
  const placed: Placed[] = [];
  const pending: TreeNode[] = [{ reference: root, dictionary: rootDictionary }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const kids: unknown[] = [];
    const children: TreeNode[] = [];
    for (const kid of next.dictionary[KIDS] as unknown[]) {
      const child = treeNode(objects, kid);
      if (child !== undefined) {
        if (claimed.has(kid as string)) continue;
        claimed.add(kid as string);
        children.push({ reference: kid as string, dictionary: child });
      }
      kids.push(kid);
    }
    placed.push({ reference: next.reference, dictionary: next.dictionary, kids });
    // One push per child, last first: a spread of a long list passes its elements as arguments and overflows the stack.
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  return placed;
}

/**
 * The dictionaries that change when the page tree below the catalog's /Pages is mended, keyed `obj:N G R`; empty when the
 * tree needs no change. Entries that do not name a node of the tree (pages, and anything else) are kept and count as one page.
 */
export function mendPageTree(objects: PdfJsonObjects): Map<string, JsonDictionary> {
  const trailer = objects.trailer?.value;
  const catalog = dictionaryOf(objects, trailer?.[ROOT]);
  const root = catalog?.[PAGES];
  const rootDictionary = treeNode(objects, root);
  if (!isReference(root) || rootDictionary === undefined) return new Map();
  const pagesBelow = new Map<string, number>();
  const pagesIn = (kid: unknown): number => pagesBelow.get(kid as string) ?? 1;
  const changed = new Map<string, JsonDictionary>();
  // A child is placed after its parent, so the reverse order finishes every child before the parent that lists it.
  for (const node of placeNodes(objects, root, rootDictionary).reverse()) {
    const kids = node.kids.filter((kid) => pagesIn(kid) > 0);
    const count = kids.reduce<number>((sum, kid) => sum + pagesIn(kid), 0);
    pagesBelow.set(node.reference, count);
    if (kids.length !== (node.dictionary[KIDS] as unknown[]).length || count !== node.dictionary[COUNT]) {
      changed.set(`${OBJECT_KEY_PREFIX}${node.reference}`, { ...node.dictionary, [KIDS]: kids, [COUNT]: count });
    }
  }
  return changed;
}

/** Whether qpdf can list the pages of the document; it cannot when the page tree loops. */
async function listsPages(workspace: QpdfWorkspace): Promise<boolean> {
  try {
    await runQpdf(workspace, { args: ['--show-pages', workspace.inputPath], action: 'Reading the pages' });
    return true;
  } catch (error) {
    if (error instanceof PdfPostprocessError) return false;
    throw error;
  }
}

interface QpdfExport {
  qpdf: [JsonDictionary, Record<string, PdfJsonObject>];
}

/**
 * `pdf` with its page tree mended (see the top of this file), or `pdf` itself when qpdf reads its pages (unless `knownLooping` says a run of qpdf has just refused them), the tree has no
 * node to mend, or qpdf cannot describe the objects within `maxExportBytes`. The pages, their content and every other object stay as they are; qpdf writes the change.
 */
export async function repairPageTree(pdf: Buffer, options: { maxExportBytes?: number; knownLooping?: boolean } = {}): Promise<Buffer> {
  return withQpdfWorkspace(pdf, async (workspace) => {
    if (options.knownLooping !== true && (await listsPages(workspace))) return pdf;
    const action = 'Mending the page tree';
    const exportLimit = { ...workspace, maxOutputBytes: options.maxExportBytes ?? PAGE_TREE_EXPORT_LIMIT_BYTES };
    let described: Awaited<ReturnType<typeof runQpdf>>;
    try {
      described = await runQpdf(exportLimit, { args: [...EXPORT_ARGS, workspace.inputPath], action, expectedOutputBytes: workspace.inputBytes });
    } catch (error) {
      // An export past its limit is not read: the document is left as it is, and the steps after this one answer as they would without it.
      if (error instanceof PdfPostprocessError) return pdf;
      throw error;
    }
    const exported = (JSON.parse(described.stdout.toString('utf8')) as QpdfExport).qpdf;
    const mended = mendPageTree(exported[1]);
    if (mended.size === 0) return pdf;
    const update = { version: JSON_VERSION, qpdf: [exported[0], Object.fromEntries([...mended].map(([key, value]) => [key, { value }]))] };
    const updatePath = path.join(workspace.dir, UPDATE_FILE);
    fs.writeFileSync(updatePath, JSON.stringify(update), { mode: 0o600 });
    return runQpdfToBuffer(workspace, { args: [`--update-from-json=${updatePath}`, workspace.inputPath, '-'], action });
  });
}
