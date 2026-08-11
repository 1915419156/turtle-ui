import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Real Loader export-path guard for the namespace TUI plugin. */
describe('dsh-tui plugin export shape', () => {
  it('preserves name, inject, Config, and apply through Loader unwrapping', () => {
    // The sibling harness owns TypeScript source resolution for its private
    // workspace packages. Probe through its source launcher so this external
    // package never mixes harness source and built faces in Vite's program.
    const root = dirname(dirname(fileURLToPath(import.meta.url)))
    const tsx = fileURLToPath(new URL('../../deepseek-harness/node_modules/.bin/tsx', import.meta.url))
    const script = `
Promise.all([
  import('./src/index.ts'),
  import('../deepseek-harness/vendor/loader/src/index.ts'),
]).then(([tui, loaderModule]) => {
  const loader = Object.create(loaderModule.default.prototype)
  const unwrapped = loader.unwrapExports(tui)
  console.log(JSON.stringify({
    same: unwrapped === tui,
    hasDefault: 'default' in tui,
    name: unwrapped.name,
    inject: unwrapped.inject,
    config: unwrapped.Config !== undefined,
    apply: typeof unwrapped.apply,
  }))
})
`
    const result = spawnSync(tsx, ['--eval', script], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({
      same: true,
      hasDefault: false,
      name: 'ui-tui',
      inject: [
        'agents',
        'sessions',
        'commands',
        'userInteraction',
        'tools',
        'llm',
        'systemPrompt',
        'tokenMeter',
        'tuiPrompt',
      ],
      config: true,
      apply: 'function',
    })
  })
})
