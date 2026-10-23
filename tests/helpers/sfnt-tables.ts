/** A copy of the TrueType program whose table directory names each table of `tags` something else, so readers do not find it. */
export function withoutTables(program: Buffer, ...tags: string[]): Buffer {
  const copy = Buffer.from(program);
  const tables = copy.readUInt16BE(4);
  for (let index = 0; index < tables; index++) {
    const record = 12 + index * 16;
    if (tags.includes(copy.toString('latin1', record, record + 4))) copy.write('zzzz', record, 'latin1');
  }
  return copy;
}
