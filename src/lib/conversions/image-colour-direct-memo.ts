/**
 * The colour memo of `ColourMemo` for a large raster, with a table indexed by the 24-bit colour itself instead of a hash of it.
 * A raster of a few megapixels holds hundreds of thousands of distinct colours (see `image-colour-memo.ts`), more than the caches of
 * a core hold, so each lookup is a cache miss; a hashed table scatters colours that sit next to each other in the picture over the
 * whole table and pays the miss twice (the slot, then the entry's key), and the 24-bit table pays it once, in a slot that its
 * neighbouring colours (a smooth region moves through a few kilobytes of it) share. The table is 64 MB of address space whose
 * pages the operating system backs when a colour first lands on them.
 *
 * The answers are the same as `ColourMemo`'s: the entry numbers follow the order in which colours were added, and a memo that
 * holds `maxEntries` entries forgets all of them. Forgetting walks the entries' keys, not the 64 MB.
 */
import { COLOUR_MEMO_LAB_STRIDE, COLOUR_MEMO_MAX_ENTRIES } from './image-colour-memo';

const COLOURS = 1 << 24;
const FIRST_CAPACITY = 1 << 16;

export class DirectColourMemo {
  /** Palette index of each entry. */
  index: Uint16Array;
  /** `COLOUR_MEMO_LAB_STRIDE` numbers per entry; empty when the memo keeps no Oklab fields. */
  lab: Float64Array;
  count = 0;
  private readonly keepsLab: boolean;
  private readonly maxEntries: number;
  private capacity: number;
  /** Entry number plus one of each colour, 0 for a colour the memo does not hold. */
  private readonly entryOf = new Uint32Array(COLOURS);
  private keys: Int32Array;

  constructor(keepsLab: boolean, maxEntries: number = COLOUR_MEMO_MAX_ENTRIES) {
    this.keepsLab = keepsLab;
    this.maxEntries = maxEntries;
    this.capacity = Math.min(maxEntries, FIRST_CAPACITY);
    this.keys = new Int32Array(this.capacity);
    this.index = new Uint16Array(this.capacity);
    this.lab = new Float64Array(keepsLab ? this.capacity * COLOUR_MEMO_LAB_STRIDE : 0);
  }

  /** The entry number of `key` (a packed 0xRRGGBB colour), or -1 when the memo does not hold it. */
  find(key: number): number {
    return this.entryOf[key] - 1;
  }

  /** Adds a colour that `find` did not return and answers its entry number, which is valid until the next `add`. */
  add(key: number, paletteIndex: number, distance2: number, l: number, a: number, b: number): number {
    if (this.count === this.maxEntries) this.clear();
    else if (this.count === this.capacity) this.grow();
    const entry = this.count;
    this.count += 1;
    this.entryOf[key] = entry + 1;
    this.keys[entry] = key;
    this.index[entry] = paletteIndex;
    if (this.keepsLab) {
      const at = entry * COLOUR_MEMO_LAB_STRIDE;
      this.lab[at] = distance2;
      this.lab[at + 1] = l;
      this.lab[at + 2] = a;
      this.lab[at + 3] = b;
    }
    return entry;
  }

  private clear(): void {
    for (let entry = 0; entry < this.count; entry += 1) this.entryOf[this.keys[entry]] = 0;
    this.count = 0;
  }

  /** Doubles the entry arrays; every entry keeps its number. */
  private grow(): void {
    this.capacity = Math.min(this.maxEntries, this.capacity * 2);
    const keys = new Int32Array(this.capacity);
    keys.set(this.keys);
    this.keys = keys;
    const index = new Uint16Array(this.capacity);
    index.set(this.index);
    this.index = index;
    if (this.keepsLab) {
      const lab = new Float64Array(this.capacity * COLOUR_MEMO_LAB_STRIDE);
      lab.set(this.lab);
      this.lab = lab;
    }
  }
}
