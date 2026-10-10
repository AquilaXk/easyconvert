import path from 'node:path';
import { REPO_ROOT } from './config';

/**
 * Where our side of a comparison comes from. A speed run of a pull request measures the pull request's code (`head`)
 * against the code of its base (`base`, a second checkout of the base commit) in the same process and the same job, so
 * the families load the product through `importProduct` and a timed run of ours can be repeated on either version.
 * Module caches are per file, so the two versions never share a module; dependencies come from the head's node_modules
 * (the base checkout links to it), so only the sources differ.
 */

export type ProductVariant = 'head' | 'base';

let baseRoot: string | null = null;
let variant: ProductVariant = 'head';

/** Names the checkout of the base commit, or none (null) for a run without an A/B comparison. */
export function configureBaseRoot(root: string | null): void {
  baseRoot = root === null ? null : path.resolve(root);
}

export const hasBase = (): boolean => baseRoot !== null;

function rootOf(which: ProductVariant): string {
  if (which === 'head') return REPO_ROOT;
  if (baseRoot === null) throw new RangeError('no base checkout is configured');
  return baseRoot;
}

/** Runs `action` with the product loaded from `which`; the previous version is restored afterwards, also on failure. */
export async function inVariant<T>(which: ProductVariant, action: () => Promise<T> | T): Promise<T> {
  const previous = variant;
  variant = which;
  try {
    return await action();
  } finally {
    variant = previous;
  }
}

/** A module of `src/` (`relative` is the path below it, without extension) of the version in use. */
export function importProduct<T>(relative: string): Promise<T> {
  return import(path.join(rootOf(variant), 'src', relative)) as Promise<T>;
}
