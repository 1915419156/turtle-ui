/** TUI command provider over a real Loader tree and lazy consumer config. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

/** Effects observed from one provider boot. */
interface Observed {
  exits: number[]
  output: string
  readerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

/* Restore process output even when an assertion fails. */
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the provider beside a consumer that reads `ctx.tuiStartup` lazily.
 * @param args - inner arguments handed over by the launcher.
 * @returns the provider service and observable consumer/process effects.
 */
async function bootProvider(args: string[]): Promise<{
  values: TuiStartupValues | undefined
  observed: Observed
}> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-'))
  const observed: Observed = { exits: [], output: '' }
  writeFileSync(join(dir, 'reader.mjs'), `
export function apply(_ctx, config) { globalThis.__tuiStartupObserved.readerConfig = config }
`)
  writeFileSync(join(dir, 'provider.mjs'), `
export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__tuiStartupApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: reader',
    `  name: ${pathToFileURL(join(dir, 'reader.mjs')).href}`,
    `  inject: [${TUI_STARTUP_SERVICE}]`,
    '  config:',
    '    sessionId: !!js ctx.tuiStartup.sessionId',
    '    resumeSessionId: !!js ctx.tuiStartup.resumeSessionId',
    '- id: provider',
    `  name: ${pathToFileURL(join(dir, 'provider.mjs')).href}`,
    '',
  ].join('\n'))
  const output = { write: (chunk: string) => { observed.output += chunk; return true } }
  internals.stdout = output
  internals.stderr = output
  const globals = globalThis as unknown as {
    __tuiStartupApply: typeof apply
    __tuiStartupObserved: Observed
  }
  globals.__tuiStartupApply = apply
  globals.__tuiStartupObserved = observed

  const ctx = new Context()
  disposers.push(async () => {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  return {
    values: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined,
    observed,
  }
}

describe('TUI command-line provider', () => {
  it('publishes a resumed session and releases direct service expressions', async () => {
    const { values, observed } = await bootProvider(['--resume', 'persisted-session'])
    expect(values).toEqual({ resumeSessionId: 'persisted-session' })
    expect(observed.readerConfig).toEqual({
      sessionId: undefined,
      resumeSessionId: 'persisted-session',
    })
    expect(observed.exits).toEqual([])
  })

  it('defaults to main and accepts an explicitly named fresh session', async () => {
    const defaultRun = await bootProvider([])
    expect(defaultRun.values).toEqual({ sessionId: 'main' })
    expect(defaultRun.observed.readerConfig).toEqual({ sessionId: 'main', resumeSessionId: undefined })

    const namedRun = await bootProvider(['--session', 'review'])
    expect(namedRun.values).toEqual({ sessionId: 'review' })
    expect(namedRun.observed.readerConfig).toEqual({ sessionId: 'review', resumeSessionId: undefined })
  })

  it('prints app help and leaves session-bound rows pending', async () => {
    const { values, observed } = await bootProvider(['--help'])
    expect(observed.output).toContain('dsh --profile tui')
    expect(observed.output).toContain('--resume <session>')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects conflicting session selectors before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--resume', 'old', '--session', 'new'])
    expect(observed.output).toContain('pass only one')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects an empty session identity before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--session', '   '])
    expect(observed.output).toContain('session id must not be empty')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })
})
