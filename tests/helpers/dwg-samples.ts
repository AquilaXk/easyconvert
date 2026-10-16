import fs from 'node:fs';
import path from 'node:path';
import { ensureSample, readRemoteManifest, type RemoteSample } from '../../bench/corpora';
import { isStrictMode } from './strict-skip';

/**
 * The licensed DWG drawings the DWG tests read. They are never committed: the pins of the entity files are in
 * tests/fixtures/dwg/entity-pins.json and the pins of the drawings are in bench/corpus/remote-manifest.json, both with
 * the origin, size and SHA-256 of the bytes, and `ensureSample` fetches a file into the benchmark cache and checks it
 * against the digest (a differing file is an error, never a different measurement). Where a file cannot be fetched a
 * run that is not strict skips; under ORACLE_STRICT_MODE=1 it fails, so CI cannot pass without having read the drawings.
 */

const ENTITY_PINS: RemoteSample[] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'dwg', 'entity-pins.json'), 'utf8')) as RemoteSample[];

/** A pinned sample by id, from the entity pins or the benchmark manifest. */
export function pinnedDwgSample(id: string): RemoteSample {
  const found = ENTITY_PINS.find((sample) => sample.id === id) ?? readRemoteManifest().samples.find((sample) => sample.id === id);
  if (found === undefined) throw new Error(`no pinned DWG sample ${id}`);
  return found;
}

/** What the test context offers: `skip` ends the test as skipped. */
interface SkippableContext {
  skip: () => never;
}

/**
 * The bytes of a pinned sample. Where the file cannot be fetched, a strict run (ORACLE_STRICT_MODE=1) throws and any other
 * run skips the test, so CI cannot pass without having read the drawing.
 */
export async function requireDwgSample(ctx: SkippableContext, id: string): Promise<Buffer> {
  try {
    return fs.readFileSync(await ensureSample(pinnedDwgSample(id)));
  } catch (error) {
    if (isStrictMode()) throw error;
    return ctx.skip();
  }
}

/** The ids of the entity samples (one line, arc and circle per release) the AutoCAD property dumps describe. */
export const ENTITY_SAMPLE_RELEASES = ['2000', '2004', '2007', '2010', '2013', '2018'] as const;
