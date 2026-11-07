import { FieldRepetitionType, PARQUET_MAX_NESTING_DEPTH, ParquetFormatError, ParquetType, ParquetUnsupportedError } from './parquet-format';
import type { Annotation } from './parquet-logical';
import type { LeafColumn } from './parquet-reader';

/**
 * The schema tree of a Parquet file and how its LIST and MAP groups are read.
 *
 * Governing spec: Apache Parquet LogicalTypes.md, "Lists" and "Maps", including their backward-compatibility rules for
 * files written before the three-level layout (a repeated primitive, a repeated group of several fields, `array` and
 * `<list>_tuple` as the element). The repetition and definition levels of a node are those of parquet.thrift: every
 * OPTIONAL or REPEATED node on the path to a leaf adds one definition level, every REPEATED node adds one repetition level.
 */

/** Joins the names of a column chunk's path; no Parquet name holds a NUL in practice, and a path never matches by accident. */
export const PATH_SEPARATOR = '\u0000';

/** One element of the footer's flattened schema list. */
export interface SchemaElement {
  name: string;
  /** Undefined for a group. */
  type: ParquetType | undefined;
  typeLength: number;
  repetition: FieldRepetitionType;
  numChildren: number;
  annotation: Annotation;
}

export type NodeKind = 'leaf' | 'struct' | 'list' | 'map';

export interface SchemaNode {
  name: string;
  repetition: FieldRepetitionType;
  kind: NodeKind;
  children: SchemaNode[];
  leaf: LeafColumn | null;
  /** Definition level at which the node itself exists, and the repetition level of the node's repeated ancestors and itself. */
  defLevel: number;
  repLevel: number;
  /** The leaves under the node are `firstLeaf` up to `endLeaf` in leaf order. */
  firstLeaf: number;
  endLeaf: number;
  /** A list: the node read once per repeated instance (the repeated child itself, or its only child). */
  element: SchemaNode | null;
  /** A map: whether its keys are text, so that it is written as an object. */
  textKeys: boolean;
}

/**
 * How a table target cuts a top-level column into cells: a map stays one cell (its keys are data, so columns made of them
 * would change with the rows), a struct becomes one column per field (the fields are schema), and everything else, a list
 * included, is a cell of its own.
 */
export type CellShape = 'plain' | 'map' | ReadonlyMap<string, CellShape>;

export interface ParsedSchema {
  leaves: LeafColumn[];
  /** Null for a flat table, where every top-level field is a leaf that is not repeated. */
  root: SchemaNode | null;
}

const TEXT_KEY_ANNOTATIONS: ReadonlySet<string> = new Set(['none', 'string', 'enum', 'json']);
const LIST_ELEMENT_NAME = 'array';
const LIST_TUPLE_SUFFIX = '_tuple';

function groupKind(element: SchemaElement): 'list' | 'map' | 'struct' {
  const { annotation } = element;
  if (annotation.tag !== 'unsupported') return 'struct';
  if (annotation.name === 'LIST') return 'list';
  if (annotation.name === 'MAP' || annotation.name === 'MAP_KEY_VALUE') return 'map';
  if (annotation.name === 'VARIANT') {
    throw new ParquetUnsupportedError(`Unsupported Parquet logical type VARIANT on column '${element.name}'`);
  }
  return 'struct';
}

class SchemaBuilder {
  private index = 1;
  readonly leaves: LeafColumn[] = [];

  constructor(private readonly elements: SchemaElement[]) {}

  get consumed(): number {
    return this.index;
  }

  parseChildren(count: number, parent: SchemaNode | null, path: string[]): SchemaNode[] {
    const children: SchemaNode[] = [];
    for (let i = 0; i < count; i++) children.push(this.parse(parent, path));
    return children;
  }

  private parse(parent: SchemaNode | null, parentPath: string[]): SchemaNode {
    if (this.index >= this.elements.length) {
      throw new ParquetFormatError('Corrupted Parquet metadata: the schema ends before all of its groups are filled');
    }
    const element = this.elements[this.index++];
    const path = [...parentPath, element.name];
    if (path.length > PARQUET_MAX_NESTING_DEPTH) {
      throw new ParquetFormatError(`Unsupported Parquet schema: nesting deeper than ${PARQUET_MAX_NESTING_DEPTH} levels`);
    }
    const node = this.createNode(element, parent, path);
    if (element.type === undefined) {
      if (element.numChildren < 1) {
        throw new ParquetFormatError(`Corrupted Parquet metadata: group '${path.join('.')}' has no fields`);
      }
      node.children = this.parseChildren(element.numChildren, node, path);
      this.shape(node, element);
    } else if (element.numChildren > 0) {
      throw new ParquetFormatError(`Corrupted Parquet metadata: column '${path.join('.')}' has a type and fields`);
    }
    node.endLeaf = this.leaves.length;
    return node;
  }

  private createNode(element: SchemaElement, parent: SchemaNode | null, path: string[]): SchemaNode {
    const defLevel = (parent?.defLevel ?? 0) + (element.repetition === FieldRepetitionType.REQUIRED ? 0 : 1);
    const repLevel = (parent?.repLevel ?? 0) + (element.repetition === FieldRepetitionType.REPEATED ? 1 : 0);
    const node: SchemaNode = {
      name: element.name,
      repetition: element.repetition,
      kind: element.type === undefined ? 'struct' : 'leaf',
      children: [],
      leaf: null,
      defLevel,
      repLevel,
      firstLeaf: this.leaves.length,
      endLeaf: this.leaves.length,
      element: null,
      textKeys: false,
    };
    if (element.type !== undefined) {
      const leaf: LeafColumn = {
        name: path.join('.'),
        colIndex: this.leaves.length,
        type: element.type,
        repetition: element.repetition,
        typeLength: element.typeLength,
        annotation: element.annotation,
        reader: { kind: 'bytes', width: 0, map: null },
        path,
        pathKey: path.join(PATH_SEPARATOR),
        maxDef: defLevel,
        maxRep: repLevel,
      };
      node.leaf = leaf;
      this.leaves.push(leaf);
    }
    return node;
  }

  /** Decides whether a group is a list, a map or a struct from its annotation and the layout of its children. */
  private shape(node: SchemaNode, element: SchemaElement): void {
    const kind = groupKind(element);
    const [repeated] = node.children;
    if (node.children.length !== 1 || repeated.repetition !== FieldRepetitionType.REPEATED) return;
    if (kind === 'list') {
      node.kind = 'list';
      node.element = listElement(node, repeated);
    } else if (kind === 'map' && repeated.kind === 'struct' && repeated.children.length <= 2) {
      this.shapeMap(node, repeated);
    }
  }

  private shapeMap(node: SchemaNode, repeated: SchemaNode): void {
    const [key, value] = repeated.children;
    if (value === undefined) {
      // A map without a value column holds only keys; it is read as the list of its keys.
      node.kind = 'list';
      node.element = key;
      return;
    }
    node.kind = 'map';
    const keyLeaf = key.leaf;
    node.textKeys = keyLeaf !== null && keyLeaf.type === ParquetType.BYTE_ARRAY && TEXT_KEY_ANNOTATIONS.has(keyLeaf.annotation.tag);
  }
}

/** LogicalTypes.md, "Backward-compatibility rules" for LIST: which node of the repeated field is one element. */
function listElement(list: SchemaNode, repeated: SchemaNode): SchemaNode {
  if (repeated.leaf !== null || repeated.children.length !== 1) return repeated;
  if (repeated.name === LIST_ELEMENT_NAME || repeated.name === `${list.name}${LIST_TUPLE_SUFFIX}`) return repeated;
  return repeated.children[0];
}

/** The cell shape of a node, taken from the schema, so it does not depend on which rows hold a null struct. */
export function cellShapeOf(node: SchemaNode): CellShape {
  if (node.repetition === FieldRepetitionType.REPEATED) return 'plain';
  if (node.kind === 'map') return 'map';
  if (node.kind !== 'struct') return 'plain';
  return new Map(node.children.map((child) => [child.name, cellShapeOf(child)]));
}

function isFlat(children: SchemaNode[]): boolean {
  return children.every((child) => child.leaf !== null && child.repetition !== FieldRepetitionType.REPEATED);
}

/** Builds the tree and the leaves, in leaf order, from the footer's flattened list of schema elements. */
export function buildSchema(elements: SchemaElement[]): ParsedSchema {
  const [rootElement] = elements;
  if (rootElement.type !== undefined || rootElement.numChildren < 0) {
    throw new ParquetFormatError('Corrupted Parquet metadata: the first schema element is not a group');
  }
  const builder = new SchemaBuilder(elements);
  const children = builder.parseChildren(rootElement.numChildren, null, []);
  if (builder.consumed !== elements.length) {
    throw new ParquetFormatError(
      `Corrupted Parquet metadata: the schema lists ${elements.length} elements but its groups hold ${builder.consumed}`
    );
  }
  const root: SchemaNode = {
    name: rootElement.name,
    repetition: FieldRepetitionType.REQUIRED,
    kind: 'struct',
    children,
    leaf: null,
    defLevel: 0,
    repLevel: 0,
    firstLeaf: 0,
    endLeaf: builder.leaves.length,
    element: null,
    textKeys: false,
  };
  return { leaves: builder.leaves, root: isFlat(children) ? null : root };
}
