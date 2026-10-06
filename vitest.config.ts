import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // tsconfig sets jsx to preserve for Next.js; vite 8 (oxc) needs an explicit runtime to compile TSX in tests.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: [
      { find: /^@\/lib\/conversions$/, replacement: path.resolve(__dirname, './src/lib/conversions/index.ts') },
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
      OCI_NAMESPACE: 'axvym6vk8g7i',
      AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      STORAGE_SIGNING_SECRET: 'test-secure-storage-signing-secret',
      S3_SIGNING_SECRET: 'test-secure-s3-signing-secret',
    },
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.worktrees/**', '**/.claude/worktrees/**'],
  },
});
