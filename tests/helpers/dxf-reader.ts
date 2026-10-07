/**
 * Hand-written DXF group-code reader for tests. It follows the file layout of the DXF reference (a stream of
 * group-code and value line pairs, SECTION and ENDSEC markers, an EOF record) and knows only the entities
 * the PostScript routes write: LINE, and POLYLINE with VERTEX and SEQEND. It never touches the writer under test.
 */

export interface DxfPoint {
  x: number;
  y: number;
  z: number;
}

export interface DxfEntityRecord {
  type: 'LINE' | 'POLYLINE';
  layer: string;
  /** LINE: start and end point. POLYLINE: the vertices in file order. */
  points: DxfPoint[];
  /** POLYLINE flag bit 1 (closed); always false for a LINE. */
  closed: boolean;
}

export interface DxfDocument {
  version: string;
  extMin: DxfPoint;
  extMax: DxfPoint;
  entities: DxfEntityRecord[];
}

const POLYLINE_CLOSED_FLAG = 1;

interface GroupPair {
  code: number;
  value: string;
}

function readPairs(text: string): GroupPair[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length % 2 !== 0) throw new Error('DXF has an odd number of lines: a group code has no value');
  const pairs: GroupPair[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new Error(`DXF line ${i + 1} is not a group code: "${lines[i]}"`);
    pairs.push({ code, value: lines[i + 1].trim() });
  }
  return pairs;
}

function readPoint(group: GroupPair[], xCode: number): DxfPoint {
  const pick = (code: number) => {
    const found = group.find((p) => p.code === code);
    if (!found) throw new Error(`DXF record has no group ${code}`);
    return Number(found.value);
  };
  return { x: pick(xCode), y: pick(xCode + 10), z: pick(xCode + 20) };
}

/** Splits the pairs into records: each record starts with a group-0 pair. */
function records(pairs: GroupPair[]): GroupPair[][] {
  const out: GroupPair[][] = [];
  for (const pair of pairs) {
    if (pair.code === 0) out.push([pair]);
    else if (out.length === 0) throw new Error('DXF has a group before the first record');
    else out[out.length - 1].push(pair);
  }
  return out;
}

/** Reads a DXF file; throws on any structure the reference layout does not allow. */
export function readDxf(text: string): DxfDocument {
  const all = records(readPairs(text));
  if (all.length === 0 || all[all.length - 1][0].value !== 'EOF') throw new Error('DXF does not end with an EOF record');
  const sections: Map<string, GroupPair[][]> = new Map();
  /** The pairs that follow a section's name: the header variables live there, not in separate records. */
  const sectionBodies: Map<string, GroupPair[]> = new Map();
  let current: GroupPair[][] | null = null;
  for (const record of all.slice(0, -1)) {
    const type = record[0].value;
    if (type === 'SECTION') {
      if (current) throw new Error('DXF SECTION opened inside a section');
      const name = record.find((p) => p.code === 2)?.value;
      if (!name) throw new Error('DXF SECTION has no name');
      current = [];
      sections.set(name, current);
      sectionBodies.set(name, record.slice(1));
    } else if (type === 'ENDSEC') {
      if (!current) throw new Error('DXF ENDSEC without a SECTION');
      current = null;
    } else if (current) {
      current.push(record);
    } else {
      throw new Error(`DXF record ${type} is outside every section`);
    }
  }
  if (current) throw new Error('DXF section is never closed');

  const header = sectionBodies.get('HEADER');
  if (!header) throw new Error('DXF has no HEADER section');
  const variable = (name: string): GroupPair[] => {
    const index = header.findIndex((p) => p.code === 9 && p.value === name);
    if (index < 0) throw new Error(`DXF header has no ${name}`);
    const next = header.findIndex((p, i) => i > index && p.code === 9);
    return header.slice(index + 1, next < 0 ? undefined : next);
  };
  const entityRecords = sections.get('ENTITIES');
  if (!entityRecords) throw new Error('DXF has no ENTITIES section');

  const entities: DxfEntityRecord[] = [];
  let polyline: DxfEntityRecord | null = null;
  for (const record of entityRecords) {
    const type = record[0].value;
    const layer = record.find((p) => p.code === 8)?.value ?? '';
    if (type === 'LINE') {
      entities.push({ type: 'LINE', layer, points: [readPoint(record, 10), readPoint(record, 11)], closed: false });
    } else if (type === 'POLYLINE') {
      const flags = Number(record.find((p) => p.code === 70)?.value ?? 0);
      polyline = { type: 'POLYLINE', layer, points: [], closed: (flags & POLYLINE_CLOSED_FLAG) !== 0 };
    } else if (type === 'VERTEX') {
      if (!polyline) throw new Error('DXF VERTEX outside a POLYLINE');
      polyline.points.push(readPoint(record, 10));
    } else if (type === 'SEQEND') {
      if (!polyline) throw new Error('DXF SEQEND without a POLYLINE');
      entities.push(polyline);
      polyline = null;
    } else {
      throw new Error(`DXF entity ${type} is not one the PostScript routes write`);
    }
  }
  if (polyline) throw new Error('DXF POLYLINE has no SEQEND');

  return {
    version: variable('$ACADVER').find((p) => p.code === 1)?.value ?? '',
    extMin: readPoint(variable('$EXTMIN'), 10),
    extMax: readPoint(variable('$EXTMAX'), 10),
    entities,
  };
}
