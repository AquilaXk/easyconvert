import path from 'node:path';

const ARCHIVE_GLOB_CACHE_MAX = 512;
const MAX_ARCHIVE_GLOB_TOKENS = 1024;
const GLOB_CHAR_SLASH = 47;
const GLOB_CHAR_STAR = 42;
const GLOB_CHAR_QUESTION = 63;
const GLOB_TOKEN_STAR = -1;
const GLOB_TOKEN_DOUBLE_STAR = -2;
const GLOB_TOKEN_QUESTION = -3;
const GLOB_TOKEN_SENTINEL = -99;

interface CompiledArchiveGlob {
  readonly hasDoubleStar: boolean;
  readonly tokens: Int32Array;
}

const archiveGlobCache = new Map<string, CompiledArchiveGlob | null>();

function cacheCompiledGlob(normPattern: string, value: CompiledArchiveGlob | null): CompiledArchiveGlob | null {
  if (archiveGlobCache.size >= ARCHIVE_GLOB_CACHE_MAX) {
    const oldest = archiveGlobCache.keys().next().value;
    if (oldest !== undefined) archiveGlobCache.delete(oldest);
  }
  archiveGlobCache.set(normPattern, value);
  return value;
}

function compileArchiveGlob(normPattern: string): CompiledArchiveGlob | null {
  const cached = archiveGlobCache.get(normPattern);
  if (cached !== undefined) return cached;

  const rawTokens: number[] = [];
  let hasDoubleStar = false;
  let i = 0;
  while (i < normPattern.length) {
    const ch = normPattern.charCodeAt(i);
    if (ch === GLOB_CHAR_STAR) {
      let end = i + 1;
      while (end < normPattern.length && normPattern.charCodeAt(end) === GLOB_CHAR_STAR) end++;
      if (end - i >= 2) {
        hasDoubleStar = true;
        rawTokens.push(GLOB_TOKEN_DOUBLE_STAR);
      } else {
        rawTokens.push(GLOB_TOKEN_STAR);
      }
      i = end;
    } else if (ch === GLOB_CHAR_QUESTION) {
      rawTokens.push(GLOB_TOKEN_QUESTION);
      i++;
    } else {
      rawTokens.push(ch);
      i++;
    }
    if (rawTokens.length > MAX_ARCHIVE_GLOB_TOKENS) {
      return cacheCompiledGlob(normPattern, null);
    }
  }

  return cacheCompiledGlob(normPattern, {
    hasDoubleStar,
    tokens: Int32Array.from(rawTokens),
  });
}

/** Exact O(|text| + |tokens|) segment-aware matcher for patterns without `**`. */
function matchSingleStarArchiveGlob(text: string, tokens: Int32Array): boolean {
  let t = 0;
  let p = 0;
  let starP = -1;
  let starT = 0;
  const tLen = text.length;
  const pLen = tokens.length;

  while (t < tLen) {
    const c = text.charCodeAt(t);
    const tok = p < pLen ? tokens[p] : GLOB_TOKEN_SENTINEL;
    if (tok === GLOB_TOKEN_STAR) {
      starP = p++;
      starT = t;
    } else if ((tok === GLOB_TOKEN_QUESTION && c !== GLOB_CHAR_SLASH) || tok === c) {
      if (c === GLOB_CHAR_SLASH) starP = -1;
      t++;
      p++;
    } else if (starP !== -1 && text.charCodeAt(starT) !== GLOB_CHAR_SLASH) {
      starT++;
      t = starT;
      p = starP + 1;
    } else {
      return false;
    }
  }
  while (p < pLen && tokens[p] === GLOB_TOKEN_STAR) p++;
  return p === pLen;
}

function advanceEpsilonStars(state: Uint8Array, tokens: Int32Array): void {
  const m = tokens.length;
  for (let j = 0; j < m; j++) {
    if (state[j] && (tokens[j] === GLOB_TOKEN_STAR || tokens[j] === GLOB_TOKEN_DOUBLE_STAR)) {
      state[j + 1] = 1;
    }
  }
}

/** Thompson NFA state-set simulation in O(|text| * |tokens|) without backtracking when `**` is present. */
function matchCompiledArchiveGlob(text: string, compiled: CompiledArchiveGlob): boolean {
  const { tokens, hasDoubleStar } = compiled;
  if (!hasDoubleStar) return matchSingleStarArchiveGlob(text, tokens);

  const m = tokens.length;
  let curr = new Uint8Array(m + 1);
  let next = new Uint8Array(m + 1);
  curr[0] = 1;
  advanceEpsilonStars(curr, tokens);

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    next.fill(0);
    let anyActive = false;
    for (let j = 0; j < m; j++) {
      if (!curr[j]) continue;
      const tok = tokens[j];
      if (tok === GLOB_TOKEN_DOUBLE_STAR || (tok === GLOB_TOKEN_STAR && c !== GLOB_CHAR_SLASH)) {
        next[j] = 1;
        anyActive = true;
      } else if ((tok === GLOB_TOKEN_QUESTION && c !== GLOB_CHAR_SLASH) || tok === c) {
        next[j + 1] = 1;
        anyActive = true;
      }
    }
    if (!anyActive) return false;
    advanceEpsilonStars(next, tokens);
    const tmp = curr;
    curr = next;
    next = tmp;
  }
  return curr[m] === 1;
}

/** Evaluates whether an archive entry path matches any of the provided glob patterns. */
export function matchArchiveGlob(filePath: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const baseName = path.basename(normalizedPath);
  for (const pattern of patterns) {
    if (!pattern) continue;
    const normPattern = pattern.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalizedPath === normPattern || baseName === normPattern) return true;
    const target = normPattern.includes('/') ? normalizedPath : baseName;
    const compiled = compileArchiveGlob(normPattern);
    if (
      compiled &&
      (matchCompiledArchiveGlob(target, compiled) ||
        (target !== normalizedPath && matchCompiledArchiveGlob(normalizedPath, compiled)))
    ) {
      return true;
    }
  }
  return false;
}
