import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../deepseek-harness/vitest.shared.ts'

export default defineConfig({
  // Harness source uses standard TypeScript decorators, which Vite's default
  // parser rejects; reuse the sibling checkout's pre-transform.
  plugins: [standardDecoratorPlugin(), tsconfigPaths({
    projects: [
      './tsconfig.vitest.json',
      '../deepseek-harness/tsconfig.base.json',
    ],
  })],
  resolve: {
    // Keep one Cordis runtime identity across this package and harness source.
    // Goal crosses several host-module augmentation boundaries, so use its
    // built face rather than mix that source module with transitive artifacts.
    alias: {
      '@deepseek-ai/cordis': fileURLToPath(new URL('../deepseek-harness/vendor/cordis/src/index.ts', import.meta.url)),
      '@deepseek-ai/dsh-goal': fileURLToPath(new URL('../deepseek-harness/packages/goal/goal/lib/index.js', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.snapshot.ts'],
    pool: 'forks',
  },
})
