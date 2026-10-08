/**
 * A small reader for the subset of WGSL that the compute shaders of this project use. No WGSL validator (naga,
 * tint) is installed on a CI shard, so the shader text is checked for structure instead: comments are removed,
 * brackets must balance, and the structs, resource bindings, entry points and uniform field accesses are
 * extracted with their types so that a test can compare them with what the host code binds and writes.
 */

export interface WgslField {
  name: string;
  type: string;
}

export interface WgslStruct {
  name: string;
  fields: WgslField[];
}

export interface WgslBinding {
  group: number;
  binding: number;
  /** `uniform`, `storage` or another address space as written. */
  addressSpace: string;
  /** `read` or `read_write` for storage, empty otherwise. */
  access: string;
  name: string;
  type: string;
}

export interface WgslEntryPoint {
  name: string;
  stage: string;
  workgroupSize: number[];
}

export interface WgslModule {
  code: string;
  structs: WgslStruct[];
  bindings: WgslBinding[];
  entryPoints: WgslEntryPoint[];
}

export class WgslSyntaxError extends Error {}

const BRACKET_PAIRS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const CLOSING_BRACKETS = new Set(Object.values(BRACKET_PAIRS));

/** Removes line and block comments (WGSL block comments nest). */
export function stripWgslComments(source: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const pair = source.slice(i, i + 2);
    if (pair === '/*') {
      depth++;
      i++;
    } else if (pair === '*/' && depth > 0) {
      depth--;
      i++;
    } else if (depth === 0 && pair === '//') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (depth === 0) {
      out += source[i];
    }
  }
  if (depth !== 0) throw new WgslSyntaxError('unterminated block comment');
  return out;
}

function assertBalanced(code: string): void {
  const stack: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch in BRACKET_PAIRS) stack.push(BRACKET_PAIRS[ch]);
    else if (CLOSING_BRACKETS.has(ch) && stack.pop() !== ch) throw new WgslSyntaxError(`unbalanced "${ch}" at offset ${i}`);
  }
  if (stack.length > 0) throw new WgslSyntaxError(`unclosed bracket, expected "${stack[stack.length - 1]}"`);
}

export function parseWgsl(source: string): WgslModule {
  const code = stripWgslComments(source);
  assertBalanced(code);

  const structs: WgslStruct[] = [...code.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}\s*;?/g)].map((match) => ({
    name: match[1],
    fields: match[2]
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean)
      .map((field) => {
        const parts = /^(\w+)\s*:(.+)$/.exec(field);
        if (!parts) throw new WgslSyntaxError(`malformed struct member "${field}" in ${match[1]}`);
        return { name: parts[1], type: parts[2].trim() };
      }),
  }));

  const bindings: WgslBinding[] = [
    ...code.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var<\s*(\w+)\s*(?:,\s*(\w+)\s*)?>\s*(\w+)\s*:([^;]+);/g),
  ].map((match) => ({
    group: Number(match[1]),
    binding: Number(match[2]),
    addressSpace: match[3],
    access: match[4] ?? '',
    name: match[5],
    type: match[6].trim(),
  }));

  const entryPoints: WgslEntryPoint[] = [
    ...code.matchAll(/@(compute|vertex|fragment)\s*(?:@workgroup_size\(([^)]*)\)\s*)?fn\s+(\w+)/g),
  ].map((match) => ({
    stage: match[1],
    name: match[3],
    workgroupSize: match[2] ? match[2].split(',').map((size) => Number(size.trim())) : [],
  }));

  return { code, structs, bindings, entryPoints };
}

/** Byte size and alignment of a scalar WGSL type used in these shaders (u32, i32, f32). */
const SCALAR_BYTES = 4;
const SCALAR_TYPES = new Set(['u32', 'i32', 'f32']);

/**
 * Size in bytes of a struct in the uniform address space made only of 32-bit scalars: members follow each
 * other without padding (alignment 4) and the struct size is rounded up to the struct alignment (4).
 */
export function scalarStructByteSize(struct: WgslStruct): number {
  for (const field of struct.fields) {
    if (!SCALAR_TYPES.has(field.type)) throw new WgslSyntaxError(`${struct.name}.${field.name} is ${field.type}, not a 32-bit scalar`);
  }
  return struct.fields.length * SCALAR_BYTES;
}

/** The members of `variable` (a uniform struct instance) that the shader code reads, in order of first use. */
export function uniformFieldsUsed(code: string, variable: string): string[] {
  const used: string[] = [];
  for (const match of code.matchAll(new RegExp(`\\b${variable}\\.(\\w+)`, 'g'))) {
    if (!used.includes(match[1])) used.push(match[1]);
  }
  return used;
}
