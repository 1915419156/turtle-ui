/** TUI command provider over a real Loader tree and lazy consumer config. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'
import {
  INITIAL_SKILL_KEY,
  TUI_GOODBYE_MESSAGE_KEY,
  TUI_RESUME_HOST_KEY,
} from '../src/host-keys.ts'
import type { TuiResumeHost } from '../src/runtime.ts'

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
 * @param options - `withLauncher` provides a launcher-shaped `profileContext`
 * whose install anchor names a fake dsh package manifest written into the
 * scratch dir (a real launcher provides this before any tree entry mounts);
 * `preprovide` stands in for host facts an embedding launcher already supplied.
 * @returns the provider service and observable consumer/process effects.
 */
async function bootProvider(args: string[], options: {
  withLauncher?: boolean
  preprovide?: Record<string, unknown>
} = {}): Promise<{
  values: TuiStartupValues | undefined
  observed: Observed
  services: {
    resumeHost: TuiResumeHost | undefined
    goodbyeMessage: string | undefined
    initialSkill: string | undefined
  }
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
  // The launcher provides profileContext before any tree entry mounts; a fake
  // dsh package manifest lets the provider resolve a re-exec invocation.
  if (options.withLauncher === true) {
    const installAnchor = join(dir, 'fake-dsh-package.json')
    writeFileSync(installAnchor, JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: 'lib/bin.js' },
    }))
    ctx.provide('profileContext', { name: 'tui', installAnchor, dir })
  }
  for (const [key, value] of Object.entries(options.preprovide ?? {})) ctx.provide(key, value)
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  return {
    values: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined,
    observed,
    services: {
      resumeHost: ctx.get(TUI_RESUME_HOST_KEY) as TuiResumeHost | undefined,
      goodbyeMessage: ctx.get(TUI_GOODBYE_MESSAGE_KEY) as string | undefined,
      initialSkill: ctx.get(INITIAL_SKILL_KEY) as string | undefined,
    },
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

  it('mints a fresh default identity and accepts an explicitly named fresh session', async () => {
    const firstDefault = await bootProvider([])
    const firstSessionId = firstDefault.values?.sessionId
    expect(firstSessionId).toEqual(expect.any(String))
    expect(firstDefault.observed.readerConfig).toEqual({
      sessionId: firstSessionId,
      resumeSessionId: undefined,
    })

    const secondDefault = await bootProvider([])
    expect(secondDefault.values?.sessionId).not.toBe(firstSessionId)

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

  it('publishes the launcher host facts a dsh-launched profile supplies', async () => {
    const { values, services } = await bootProvider(['--session', 'review'], { withLauncher: true })
    expect(values).toEqual({ sessionId: 'review' })
    expect(services.resumeHost).toBeDefined()
    expect(services.goodbyeMessage).toBe('To resume this session: dsh --profile tui --resume review')
    expect(services.initialSkill).toBeUndefined()
  })

  it('leaves the launcher host facts absent without a profileContext', async () => {
    const { services } = await bootProvider([])
    expect(services.resumeHost).toBeUndefined()
    expect(services.goodbyeMessage).toBeUndefined()
  })

  it('seeds a fresh session with a guided skill and keeps the resume form seeded-free', async () => {
    const guided = await bootProvider(['--skill', 'migrate'], { withLauncher: true })
    expect(guided.values?.sessionId).toEqual(expect.any(String))
    expect(guided.services.initialSkill).toBe('migrate')
    expect(guided.services.goodbyeMessage).toContain(`--resume ${guided.values?.sessionId}`)

    const resumed = await bootProvider(['--resume', 'old', '--skill', 'migrate'])
    expect(resumed.observed.output).toContain('pass only one')
    expect(resumed.services.initialSkill).toBeUndefined()
    expect(resumed.observed.exits).toEqual([1])

    const empty = await bootProvider(['--skill', '  '])
    expect(empty.observed.output).toContain('skill name must not be empty')
    expect(empty.services.initialSkill).toBeUndefined()
    expect(empty.observed.exits).toEqual([1])
  })

  it('trims whitespace-padded flag values before storing them', async () => {
    // Commander passes option values verbatim, and every published value is
    // matched exactly downstream (a skill name against the registry, a resume
    // id against the session store, the exit line's printed command), so the
    // flag boundary is where padding must be removed.
    const named = await bootProvider(['--session', '  review  '], { withLauncher: true })
    expect(named.values).toEqual({ sessionId: 'review' })
    expect(named.services.goodbyeMessage).toBe('To resume this session: dsh --profile tui --resume review')

    const resumed = await bootProvider(['--resume', '  persisted  '])
    expect(resumed.values).toEqual({ resumeSessionId: 'persisted' })

    const guided = await bootProvider(['--skill', '  migrate  '])
    expect(guided.services.initialSkill).toBe('migrate')
  })

  it('leaves host facts an embedding launcher already provided untouched', async () => {
    // A second ctx.provide of the same service name would throw, so the
    // provider must detect the embedding launcher's own values and stand down.
    const embedderHost = { handoff: () => Promise.reject(new Error('embedder host called')) }
    const { services } = await bootProvider(['--session', 'review'], {
      withLauncher: true,
      preprovide: {
        [TUI_GOODBYE_MESSAGE_KEY]: 'embedder wording',
        [TUI_RESUME_HOST_KEY]: embedderHost,
      },
    })
    expect(services.goodbyeMessage).toBe('embedder wording')
    expect(services.resumeHost).toBe(embedderHost)
    await expect(services.resumeHost?.handoff(SessionId('x'), '/cwd')).rejects.toThrow('embedder host called')
  })
})
