/**
 * Memo of what a palette search answered for each distinct 24-bit colour of a raster: the palette index and, when
 * the caller keeps runs, the colour's squared distance to that palette entry and its Oklab coordinates.
 *
 * A photograph repeats colours (a 12-megapixel picture holds about 350,000 distinct ones, about 7 percent of its
 * pixels), so the palette is searched once per distinct colour and every other pixel is a table lookup. The table
 * is open addressing with linear probing (Knuth, TAOCP vol. 3, 6.4) over entry numbers, at most half full, and
 * doubles when the entries reach that. Entries are stored in the order they are added, which follows the picture, so
 * the colours that sit next to each other in it sit next to each other in memory.
 *
 * Memory is bounded: when `maxEntries` entries are held the memo is emptied and refills from the next colour on. The
 * answers are exact either way, so a full memo costs speed (a colour is searched again), never correctness.
 */

const EMPTY = -1;
const MIN_SLOT_BITS = 4;
const MAX_INITIAL_SLOT_BITS = 16;
const HASH_MULTIPLIER = 0x9e3779b1;
/** Fields kept per entry when the caller keeps runs: squared distance to the nearest palette colour, then L, a, b. */
export const COLOUR_MEMO_LAB_STRIDE = 4;
/** Most entries held before the memo is emptied: about 46 MB with the Oklab fields, 7 MB without. */
export const COLOUR_MEMO_MAX_ENTRIES = 1 << 20;

export class ColourMemo {
  /** Palette index of each entry. */
  index: Uint16Array;
  /** `COLOUR_MEMO_LAB_STRIDE` numbers per entry; empty when the memo keeps no Oklab fields. */
  lab: Float64Array;
  count = 0;
  private readonly keepsLab: boolean;
  private readonly maxEntries: number;
  private slotBits: number;
  private slots: Int32Array;
  private keys: Int32Array;

  /** `expectedColours` (at most the raster's pixel count) sizes the first table, so a small raster allocates little. */
  constructor(keepsLab: boolean, expectedColours: number = Infinity, maxEntries: number = COLOUR_MEMO_MAX_ENTRIES) {
    this.keepsLab = keepsLab;
    this.maxEntries = maxEntries;
    this.slotBits = Math.max(MIN_SLOT_BITS, Math.min(MAX_INITIAL_SLOT_BITS, Math.ceil(Math.log2(2 * expectedColours))));
    const entries = this.entryCapacity();
    this.slots = new Int32Array(1 << this.slotBits).fill(EMPTY);
    this.keys = new Int32Array(entries);
    this.index = new Uint16Array(entries);
    this.lab = new Float64Array(keepsLab ? entries * COLOUR_MEMO_LAB_STRIDE : 0);
  }

  /** The entry number of `key` (a packed 0xRRGGBB colour), or -1 when the memo does not hold it. */
  find(key: number): number {
    const mask = this.slots.length - 1;
    let slot = Math.imul(key, HASH_MULTIPLIER) >>> (32 - this.slotBits);
    let entry = this.slots[slot];
    while (entry !== EMPTY && this.keys[entry] !== key) {
      slot = (slot + 1) & mask;
      entry = this.slots[slot];
    }
    return entry;
  }

  /**
   * Adds a colour that `find` did not return and answers its entry number, which is valid until the next `add`.
   * `distance2` (squared distance to the palette entry) and `l`, `a`, `b` (the colour in Oklab) are kept only when
   * the memo keeps the Oklab fields.
   */
  add(key: number, paletteIndex: number, distance2: number, l: number, a: number, b: number): number {
    if (this.count === this.maxEntries) this.clear();
    else if (this.count === this.entryCapacity()) this.grow();
    const entry = this.count;
    this.count += 1;
    this.slots[this.freeSlot(key)] = entry;
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

  private entryCapacity(): number {
    return Math.min(this.maxEntries, 1 << (this.slotBits - 1));
  }

  private freeSlot(key: number): number {
    const mask = this.slots.length - 1;
    let slot = Math.imul(key, HASH_MULTIPLIER) >>> (32 - this.slotBits);
    while (this.slots[slot] !== EMPTY) slot = (slot + 1) & mask;
    return slot;
  }

  private clear(): void {
    this.slots.fill(EMPTY);
    this.count = 0;
  }

  /** Doubles the table and the entry arrays; every entry keeps its number. */
  private grow(): void {
    this.slotBits += 1;
    this.slots = new Int32Array(1 << this.slotBits).fill(EMPTY);
    const entries = this.entryCapacity();
    const keys = new Int32Array(entries);
    keys.set(this.keys);
    this.keys = keys;
    const index = new Uint16Array(entries);
    index.set(this.index);
    this.index = index;
    if (this.keepsLab) {
      const lab = new Float64Array(entries * COLOUR_MEMO_LAB_STRIDE);
      lab.set(this.lab);
      this.lab = lab;
    }
    for (let entry = 0; entry < this.count; entry += 1) this.slots[this.freeSlot(this.keys[entry])] = entry;
  }
}
