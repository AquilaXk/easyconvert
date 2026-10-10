import { SaxesParser } from 'saxes';
import { DataParseError } from '../types';

/**
 * Well-formedness gate for the XML parts of a document package (OOXML, ODF, HWPX).
 *
 * The document readers pick values out of a part with tag patterns. Those patterns cannot tell a document
 * from a broken one: given a part cut off mid-tag they return whatever matched, usually nothing, and the
 * conversion would report success with an empty result. Every part a reader depends on goes through this
 * check first, so a part that is not XML 1.0 is refused with the position of the first error.
 *
 * Prefixes are not resolved (no namespace pass): hand-written and exported packages leave declarations
 * out, and a missing declaration does not change what the patterns read. Entities other than the five
 * predefined ones and character references are errors, so nothing is ever expanded here.
 */
export function assertWellFormedXml(partName: string, xml: string, packageLabel: string): void {
  const parser = new SaxesParser({ xmlns: false, position: true, defaultXMLVersion: '1.0', forceXMLVersion: true });
  parser.on('error', (err) => {
    throw new DataParseError(`Invalid ${packageLabel} package: ${partName} is not well-formed XML (${err.message}).`, {
      line: parser.line,
      column: parser.column + 1,
    });
  });
  parser.write(xml).close();
}
