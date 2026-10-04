import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@/lib/conversions', replacement: path.resolve(__dirname, './src/lib/conversions/index.ts') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
  },
  test: {
    environment: 'node',
    env: {
      ANONYMOUS_DAILY_LIMIT: '10000',
      ANONYMOUS_BURST_CAPACITY: '10000',
      ANONYMOUS_BURST_REFILL_RATE: '10000',
    },
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.worktrees/**', '**/.claude/worktrees/**'],
  },
});
