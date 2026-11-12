/**
 * The member names that appear more than once in one JSON object of a request text. `JSON.parse` keeps the last of two
 * members with one name and says nothing, so two tasks of one name would silently become one; this reads the text itself, once,
 * and only for the object that holds the tasks.
 */

const WHITESPACE = /\s/;

/** A cursor over JSON text that is known to parse (the request body was read with `JSON.parse` first), so it never validates. */
class JsonCursor {
  private index = 0;

  constructor(private readonly text: string) {}

  private skipSpace(): void {
    while (this.index < this.text.length && WHITESPACE.test(this.text[this.index])) this.index++;
  }

  /** The decoded string whose opening quote is at the cursor. */
  private readString(): string {
    const start = this.index++;
    while (this.text[this.index] !== '"') this.index += this.text[this.index] === '\\' ? 2 : 1;
    this.index++;
    return JSON.parse(this.text.slice(start, this.index)) as string;
  }

  /** Moves past the value at the cursor. */
  private skipValue(): void {
    this.skipSpace();
    const first = this.text[this.index];
    if (first === '"') {
      this.readString();
    } else if (first === '{' || first === '[') {
      this.index++;
      for (this.skipSpace(); this.text[this.index] !== (first === '{' ? '}' : ']'); this.skipSpace()) {
        if (first === '{') {
          this.readString();
          this.skipSpace();
          this.index++;
        }
        this.skipValue();
        this.skipSpace();
        if (this.text[this.index] === ',') this.index++;
      }
      this.index++;
    } else {
      while (this.index < this.text.length && !/[\s,}\]]/.test(this.text[this.index])) this.index++;
    }
  }

  /**
   * The members of the object at the cursor, in order, as name and the offset of the value; an empty list when the value there is
   * not an object.
   */
  members(): Array<{ name: string; valueAt: number }> {
    this.skipSpace();
    if (this.text[this.index] !== '{') return [];
    const found: Array<{ name: string; valueAt: number }> = [];
    this.index++;
    for (this.skipSpace(); this.text[this.index] !== '}'; this.skipSpace()) {
      const name = this.readString();
      this.skipSpace();
      this.index++;
      this.skipSpace();
      found.push({ name, valueAt: this.index });
      this.skipValue();
      this.skipSpace();
      if (this.text[this.index] === ',') this.index++;
    }
    return found;
  }

  moveTo(index: number): void {
    this.index = index;
  }
}

function repeatedNames(members: ReadonlyArray<{ name: string }>): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { name } of members) (seen.has(name) ? repeated : seen).add(name);
  return [...repeated];
}

/**
 * The names used by more than one member of the object `json` is, or, with `member`, of the object held by the top-level member
 * of that name of `json` (the last one, as `JSON.parse` reads it). `json` must be valid JSON.
 */
export function duplicateKeys(json: string, member?: string): string[] {
  const cursor = new JsonCursor(json);
  if (member === undefined) return repeatedNames(cursor.members());
  const holder = cursor.members().filter((m) => m.name === member).at(-1);
  if (!holder) return [];
  cursor.moveTo(holder.valueAt);
  return repeatedNames(cursor.members());
}
