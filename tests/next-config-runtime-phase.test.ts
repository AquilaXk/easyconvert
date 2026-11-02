import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants.js';
import { describe, expect, it, vi } from 'vitest';

const pluginLoaded = vi.fn();
vi.mock('next-intl/plugin', () => {
  pluginLoaded();
  return { default: () => (nextConfig: object) => ({ ...nextConfig, webpack: (webpackConfig: unknown) => webpackConfig }) };
});

describe('the framework config of the production server', () => {
  it('does not load the i18n plugin, whose native compiler cannot unpack itself in a read-only container', async () => {
    const { default: config } = await import('../next.config.mjs');
    const served = await config(PHASE_PRODUCTION_SERVER);
    expect(pluginLoaded).not.toHaveBeenCalled();
    expect(served.webpack).toBeUndefined();
  });

  it('applies the i18n plugin when the app is built', async () => {
    const { default: config } = await import('../next.config.mjs');
    const built = await config(PHASE_PRODUCTION_BUILD);
    expect(pluginLoaded).toHaveBeenCalledTimes(1);
    expect(typeof built.webpack).toBe('function');
  });
});
