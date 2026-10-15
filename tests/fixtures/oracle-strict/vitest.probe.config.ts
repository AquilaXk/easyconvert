import { defineConfig } from 'vitest/config';
import baseConfig from '../../../vitest.config';

/**
 * Collects only the missing-tool probe, which the suite's own include pattern deliberately does not match.
 * The base settings are reused as they are except `include`, which must be replaced and not merged: a merged
 * list would also collect the whole suite.
 */
const { include: _suiteInclude, ...baseTestSettings } = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTestSettings,
    include: ['tests/fixtures/oracle-strict/*.probe.ts'],
  },
});
