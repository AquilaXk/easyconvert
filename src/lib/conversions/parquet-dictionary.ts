/**
 * Open-addressing hash table over 64-bit float patterns for numeric dictionary encoding.
 * Keys compare by their IEEE-754 bit pattern, so -0.0 and +0.0 stay distinct entries; entries are
 * numbered in first-seen order, which is the order of the dictionary page.
 */

/** Table slots per allowed entry: a load factor of at most one half keeps probe chains short. */
const SLOTS_PER_ENTRY = 2;
const MIN_TABLE_SLOTS = 16;
const EMPTY_SLOT = -1;
const HASH_MULTIPLIER_LOW = 0x9e3779b1;
const HASH_MULTIPLIER_HIGH = 0x85ebca6b;
const HASH_FINAL_SHIFT = 15;

export class NumericDictionary {
  readonly values: Float64Array;
  count = 0;
  private readonly table: Int32Array;
  private readonly mask: number;
  private readonly keysLow: Int32Array;
  private readonly keysHigh: Int32Array;
  private readonly scratch = new Float64Array(1);
  private readonly scratchBits = new Int32Array(this.scratch.buffer);

  /** `maxEntries` bounds the dictionary; `expectedValues` sizes the table for small chunks. */
  constructor(private readonly maxEntries: number, expectedValues: number) {
    const wanted = Math.min(maxEntries, expectedValues) * SLOTS_PER_ENTRY;
    let slots = MIN_TABLE_SLOTS;
    while (slots < wanted) slots *= 2;
    this.table = new Int32Array(slots).fill(EMPTY_SLOT);
    this.mask = slots - 1;
    const capacity = Math.min(maxEntries, expectedValues);
    this.values = new Float64Array(capacity);
    this.keysLow = new Int32Array(capacity);
    this.keysHigh = new Int32Array(capacity);
  }

  /** Returns the entry index of `v`, adding it first when new; -1 when the dictionary is full. */
  indexOf(v: number): number {
    this.scratch[0] = v;
    const low = this.scratchBits[0];
    const high = this.scratchBits[1];
    let h = Math.imul(low, HASH_MULTIPLIER_LOW) ^ Math.imul(high, HASH_MULTIPLIER_HIGH);
    h ^= h >>> HASH_FINAL_SHIFT;
    let slot = h & this.mask;
    for (;;) {
      const entry = this.table[slot];
      if (entry === EMPTY_SLOT) break;
      if (this.keysLow[entry] === low && this.keysHigh[entry] === high) return entry;
      slot = (slot + 1) & this.mask;
    }
    if (this.count >= this.maxEntries || this.count >= this.values.length) return -1;
    const index = this.count++;
    this.table[slot] = index;
    this.values[index] = v;
    this.keysLow[index] = low;
    this.keysHigh[index] = high;
    return index;
  }
}
