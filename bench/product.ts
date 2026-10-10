import path from 'node:path';
import { REPO_ROOT } from './config';

/**
 * Where our side of a comparison comes from. A process loads the product of one checkout: this repository, or the one
 * named by BENCH_PRODUCT_ROOT. The base of a change is measured by a second process started in the checkout of the base
 * commit with that variable set (bench/ab-host.ts), so its modules, tsconfig and node_modules are its own and the two
 * versions share nothing but the benchmark's code.
 */
export const productRoot = (env: Readonly<Record<string, string | undefined>> = process.env): string => (env.BENCH_PRODUCT_ROOT ? path.resolve(env.BENCH_PRODUCT_ROOT) : REPO_ROOT);

/** A module of `src/` (`relative` is the path below it, without extension) of the checkout this process measures. */
export function importProduct<T>(relative: string): Promise<T> {
  return import(path.join(productRoot(), 'src', relative)) as Promise<T>;
}
