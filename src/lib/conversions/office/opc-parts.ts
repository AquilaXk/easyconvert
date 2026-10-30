import type JSZip from 'jszip';
import { PayloadLimitError } from '../../types';
import { safeExtractXmlElements, type SafeXmlElement } from '../safe-xml-scanner';
import { readZipEntryText, type ZipEntryReadOptions } from '../zip-entry-reader';
import { resolveZipPath } from './zip-path';

/**
 * Relationship elements one read of a package scans, over all of its parts: one for each of the 1,048,576 hyperlinks a workbook may
 * hold, with the same again for the relationships that go with them (the sheet part is scanned for its drawings as well as its
 * links) and for the sheets. A part is scanned in full whatever the ids asked for, so the scan and not the map it fills is what
 * costs CPU: measured, a million `Relationship` elements take under a second.
 */
export const OPC_MAX_RELATIONSHIPS_SCANNED = 2_097_152;

/** What is left of the relationship scans of one package read. */
export interface RelationshipAllowance {
  remaining: number;
}

export function newRelationshipAllowance(): RelationshipAllowance {
  return { remaining: OPC_MAX_RELATIONSHIPS_SCANNED };
}

export interface OpcReadOptions extends ZipEntryReadOptions {
  /** Shared by every relationships part a package read scans; a call that is given none has an allowance of its own. */
  relationships?: RelationshipAllowance;
}

export interface PartRelationship {
  type: string;
  /** The package path of the target, or the URL as written for a relationship that points outside the package. */
  target: string;
  external: boolean;
}

/** Keeps only the relationships it accepts, so that the map follows what the caller uses and not what the part lists. */
export type RelationshipFilter = (id: string, type: string, external: boolean) => boolean;

/**
 * Hands the elements of one tag to `onElement` as the scanner finds them, so that no list of them is held, and refuses (413) the
 * one past `limit` with `refusal`: the scanner's own limit of 50,000 elements would end the list there without a word. The scan
 * stops at that element, so a part that holds millions costs the time of `limit` of them.
 */
export function streamElementsWithin(xml: string, tagName: string, limit: number, refusal: string, onElement: (element: SafeXmlElement) => void): void {
  let taken = 0;
  safeExtractXmlElements(xml, tagName, {
    maxElements: limit + 1,
    onElement: (element) => {
      taken += 1;
      if (taken > limit) throw new PayloadLimitError(refusal);
      onElement(element);
    },
  });
}

/**
 * Like {@link streamElementsWithin}, for a list that may be cut: the scan ends after `limit` elements without a word, and the
 * count of the elements taken is returned.
 */
export function streamFirstElements(xml: string, tagName: string, limit: number, onElement: (element: SafeXmlElement) => void): number {
  let taken = 0;
  safeExtractXmlElements(xml, tagName, {
    maxElements: Math.max(0, limit),
    onElement: (element) => {
      taken += 1;
      onElement(element);
    },
  });
  return taken;
}

/** Hands each `Relationship` of a relationships part to `onRelationship`, counting them against `allowance`; the one past it is refused (413). */
export function forEachRelationship(xml: string, allowance: RelationshipAllowance, onRelationship: (relationship: SafeXmlElement) => void): void {
  let scanned = 0;
  try {
    streamElementsWithin(
      xml,
      'Relationship',
      allowance.remaining,
      `The relationships of the package list more than ${OPC_MAX_RELATIONSHIPS_SCANNED} relationships in all.`,
      (relationship) => {
        scanned += 1;
        onRelationship(relationship);
      }
    );
  } finally {
    allowance.remaining -= scanned;
  }
}

/**
 * The relationships of a part that sits in `directory` that `accept` keeps, by relationship id. Internal targets are resolved to
 * package paths; the targets of relationships that point outside the package are the URLs as written.
 */
export function readRelationships(xml: string, directory: string, allowance: RelationshipAllowance, accept: RelationshipFilter): Map<string, PartRelationship> {
  const relationships = new Map<string, PartRelationship>();
  forEachRelationship(xml, allowance, (rel) => {
    const { Id: id, Target: target, TargetMode: mode } = rel.attrs;
    if (!id || !target) return;
    const type = rel.attrs.Type ?? '';
    const external = mode === 'External';
    if (!accept(id, type, external)) return;
    relationships.set(id, { type, target: external ? target : resolveZipPath(directory, target), external });
  });
  return relationships;
}

/** The relationships part of a part: `xl/workbook.xml` has `xl/_rels/workbook.xml.rels`. */
export function relationshipsPartOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/**
 * The relationships of a package part that `accept` keeps, read under the package's decoded-byte budget when the options carry one. A part without a relationships part has none.
 */
export async function readPartRelationships(zip: JSZip, part: string, options: OpcReadOptions, accept: RelationshipFilter): Promise<Map<string, PartRelationship>> {
  const relsFile = zip.file(relationshipsPartOf(part));
  if (!relsFile) return new Map();
  const { relationships, ...read } = options;
  const xml = await readZipEntryText(relsFile, read.budget ? { ...read, maxBytes: read.budget.limit } : read);
  return readRelationships(xml, part.slice(0, Math.max(0, part.lastIndexOf('/'))), relationships ?? newRelationshipAllowance(), accept);
}
