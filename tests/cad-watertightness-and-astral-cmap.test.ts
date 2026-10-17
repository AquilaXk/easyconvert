import { describe, it, expect } from 'vitest';
import { createToUnicodeCMap } from '../src/lib/conversions/ocr-pdf-combiner';
import { readToUnicodeCMap } from './helpers/cmap-reader';

describe('Phase 5: Astral Unicode CMap Compliance', () => {
  describe('1. ISO 32000-1 Astral Unicode ToUnicode CMap Generation', () => {
    it('maps 2-byte CID to 4-byte UTF-16BE surrogate pair for astral characters (> 0xFFFF)', () => {
      // Astral characters:
      // U+1F600 (Grinning Face): surrogate pair 0xD83D, 0xDE00 -> hex "D83DDE00"
      // U+2000B (CJK Extension B): surrogate pair 0xD840, 0xDC0B -> hex "D840DC0B"
      // U+10000 (Linear B): surrogate pair 0xD800, 0xDC00 -> hex "D800DC00"
      // BMP characters:
      // U+0041 ('A'): hex "0041"
      // U+AC00 ('가'): hex "AC00"
      const mappings: Array<[number, number]> = [
        [0x0001, 0x0041], // CID 1 -> 'A'
        [0x0002, 0xac00], // CID 2 -> '가'
        [0x0003, 0x1f600], // CID 3 -> Grinning Face (Astral)
        [0x0004, 0x2000b], // CID 4 -> CJK Ext B (Astral)
        [0x0005, 0x10000], // CID 5 -> Linear B (Astral)
      ];

      // Read the stream back the way a PDF consumer does (tests/helpers/cmap-reader.ts, written from
      // ISO 32000-1 9.10.3 and Adobe TN 5014), not by searching the generated text.
      const cmap = readToUnicodeCMap(createToUnicodeCMap(mappings));

      // Source codes stay two bytes wide; the astral destinations are UTF-16BE surrogate pairs, never CIDs of their own.
      expect(cmap.codespaces).toEqual([{ low: 0, high: 0xffff, bytes: 2 }]);
      expect(cmap.bfranges).toEqual([]);
      expect([...cmap.bfchars.keys()]).toEqual([0x0001, 0x0002, 0x0003, 0x0004, 0x0005]);
      expect(Object.fromEntries([...cmap.bfchars].map(([code, text]) => [code, [...text].map((c) => c.codePointAt(0))]))).toEqual({
        1: [0x0041],
        2: [0xac00],
        3: [0x1f600],
        4: [0x2000b],
        5: [0x10000],
      });
      // The surrogate halves in the destinations, as UTF-16 code units (hand-derived: cp - 0x10000 split 10/10 bits).
      expect(cmap.bfchars.get(3)!.length).toBe(2);
      expect([cmap.bfchars.get(3)!.charCodeAt(0), cmap.bfchars.get(3)!.charCodeAt(1)]).toEqual([0xd83d, 0xde00]);
      expect([cmap.bfchars.get(4)!.charCodeAt(0), cmap.bfchars.get(4)!.charCodeAt(1)]).toEqual([0xd840, 0xdc0b]);
      expect([cmap.bfchars.get(5)!.charCodeAt(0), cmap.bfchars.get(5)!.charCodeAt(1)]).toEqual([0xd800, 0xdc00]);
    });

    it('generates standard identity CMap when no mappings are provided', () => {
      // ISO 32000-1 9.10.3: only the last byte may vary inside a bfrange, so no identity range is emitted; an empty
      // table is a bare two-byte codespace and no mapping at all.
      const cmap = readToUnicodeCMap(createToUnicodeCMap());
      expect(cmap.name).toBe('Custom-ToUnicode');
      expect(cmap.codespaces).toEqual([{ low: 0, high: 0xffff, bytes: 2 }]);
      expect(cmap.bfchars.size).toBe(0);
      expect(cmap.bfranges).toEqual([]);
    });
  });
});
