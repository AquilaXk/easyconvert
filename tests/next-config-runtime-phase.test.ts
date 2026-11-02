import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants.js';
import { describe, expect, it } from 'vitest';
import config from '../next.config.mjs';

/**
 * The framework config of the production server (docs/policy-decisions.md, entry 141). `next start` reads next.config.mjs in
 * the production container, whose root is read-only and whose scratch is noexec; the i18n plugin loads a native compiler that
 * cannot unpack itself there, which stopped the v0.7.0 web server. The server phase therefore takes the plain config, and only
 * the build applies the plugin. Nothing is mocked: each phase runs in a fresh Node process that records every module it
 * resolves and every native addon it opens.
 */

const ROOT = path.resolve(__dirname, '..');

/** The modules a fresh Node process resolves, and the native addons it opens, while it reads next.config.mjs for `phase`. */
function modulesLoadedFor(phase: string): string[] {
  const script = `
    import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({ resolve(specifier, context, next) { const resolved = next(specifier, context); loaded.push(resolved.url); return resolved; } });
    const dlopen = process.dlopen;
    process.dlopen = (module, filename, ...rest) => { loaded.push('native:' + filename); return dlopen(module, filename, ...rest); };
    const { default: config } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'next.config.mjs')).href)});
    await config(${JSON.stringify(phase)});
    process.stdout.write(JSON.stringify(loaded));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as string[];
}

const NATIVE_OR_COMPILER = /@swc[/+]core|\.node$|^native:/;

describe('the framework config of the production server', () => {
  it('loads no native compiler or addon when the server reads it', () => {
    const loaded = modulesLoadedFor(PHASE_PRODUCTION_SERVER);

    expect(loaded.some((url) => url.includes('/next.config.mjs'))).toBe(true);
    expect(loaded.filter((url) => NATIVE_OR_COMPILER.test(url) || url.includes('/next-intl/'))).toEqual([]);
  });

  it('loads the i18n plugin when the app is built, so the recording sees what a phase loads', () => {
    expect(modulesLoadedFor(PHASE_PRODUCTION_BUILD).some((url) => url.includes('/next-intl/'))).toBe(true);
  });

  it('serves every setting the build has, and only the plugin adds to the built one', async () => {
    const served = await config(PHASE_PRODUCTION_SERVER);
    const built = await config(PHASE_PRODUCTION_BUILD);

    expect(built).toMatchObject(served);
    expect(served.webpack).toBeUndefined();
  });

  it('aliases next-intl/config to the request config of the app in the build', async () => {
    const built = await config(PHASE_PRODUCTION_BUILD);
    const webpackConfig = { context: ROOT, resolve: { alias: {} as Record<string, string> }, module: { rules: [] as unknown[] } };

    const configured = built.webpack?.(webpackConfig, {} as never) as typeof webpackConfig;

    expect(configured.resolve.alias['next-intl/config']).toBe(path.join(ROOT, 'src', 'i18n', 'request.ts'));
  });
});
