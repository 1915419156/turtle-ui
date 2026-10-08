/** Launcher facts: the in-place resume host, its invocation resolution, and the exit line. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createResumeHost,
  formatGoodbyeMessage,
  launcherEnvironment,
  resolveLauncherInvocation,
} from '../src/launcher.ts'

const dirs: string[] = []

function scratchPackage(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-launcher-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'lib'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return join(dir, 'package.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('launcher environment', () => {
  it('reads the profile name and install anchor from a provided profileContext', () => {
    const anchor = scratchPackage({ name: '@deepseek-ai/dsh' })
    expect(launcherEnvironment({
      get: () => ({ name: 'tui', installAnchor: anchor, dir: '/profiles/tui' }),
    })).toEqual({ profile: 'tui', installAnchor: anchor })
  })

  it('reports no environment without a profileContext or a name', () => {
    expect(launcherEnvironment({ get: () => undefined })).toBeUndefined()
    expect(launcherEnvironment({ get: () => ({ installAnchor: '/x' }) })).toBeUndefined()
    expect(launcherEnvironment({ get: () => ({ name: 'tui' }) }))
      .toEqual({ profile: 'tui', installAnchor: undefined })
  })
})

describe('launcher invocation', () => {
  it('resolves the dsh bin under the current Node.js executable', () => {
    const anchor = scratchPackage({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } })
    const invocation = resolveLauncherInvocation(anchor, '/usr/bin/node')
    expect(invocation).toEqual({
      command: '/usr/bin/node',
      args: [join(anchor, '..', 'lib', 'bin.js')],
    })
  })

  it('accepts a string bin and rejects an unusable anchor', () => {
    const stringBin = scratchPackage({ name: '@deepseek-ai/dsh', bin: 'cli.js' })
    expect(resolveLauncherInvocation(stringBin, '/node')?.args).toEqual([join(stringBin, '..', 'cli.js')])
    expect(resolveLauncherInvocation(undefined)).toBeUndefined()
    expect(resolveLauncherInvocation(scratchPackage({ name: 'x' }))).toBeUndefined()
    const missing = join(tmpdir(), 'dsh-tui-launcher-missing', 'package.json')
    expect(resolveLauncherInvocation(missing)).toBeUndefined()
  })
})

describe('resume host', () => {
  const invocation = { command: '/node', args: ['/dsh/lib/bin.js'] }

  it('re-execs the launcher into the session workspace and mirrors its exit status', async () => {
    const spawn = vi.fn(() => ({ status: 7 }))
    const exit = vi.fn()
    const host = createResumeHost({ invocation, profile: 'tui', spawn, exit })
    // A default boundary would end this process; the injectable exit proves the
    // handoff commits instead, and the rejection reports a launcher that
    // returned without replacing the process.
    await expect(host.handoff(SessionId('picked'), '/work/space')).rejects.toThrow('status 7')
    expect(spawn).toHaveBeenCalledWith(
      '/node',
      ['/dsh/lib/bin.js', '--profile', 'tui', '--resume', 'picked'],
      { cwd: '/work/space', stdio: 'inherit' },
    )
    expect(exit).toHaveBeenCalledWith(7)
  })

  it('reports a spawn failure without exiting', async () => {
    const exit = vi.fn()
    const host = createResumeHost({
      invocation,
      profile: 'tui',
      spawn: () => ({ error: new Error('ENOENT'), status: null }),
      exit,
    })
    await expect(host.handoff(SessionId('picked'), '/work/space'))
      .rejects.toThrow('cannot re-exec the dsh launcher: ENOENT')
    expect(exit).not.toHaveBeenCalled()
  })

  it('reports a throwing spawn and treats a null status as failure', async () => {
    const exit = vi.fn()
    const throwing = createResumeHost({
      invocation,
      profile: 'tui',
      spawn: () => { throw new Error('EPERM') },
      exit,
    })
    await expect(throwing.handoff(SessionId('picked'), '/cwd'))
      .rejects.toThrow('cannot re-exec the dsh launcher: EPERM')
    const nullStatus = createResumeHost({ invocation, profile: 'tui', spawn: () => ({ status: null }), exit })
    await expect(nullStatus.handoff(SessionId('picked'), '/cwd')).rejects.toThrow('status 1')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('re-execs a bare launcher invocation for a fresh session', async () => {
    const spawn = vi.fn(() => ({ status: 0 }))
    const exit = vi.fn()
    const host = createResumeHost({ invocation, profile: 'tui', spawn, exit })
    await expect(host.handoffNew?.('/work/space')).rejects.toThrow('status 0')
    // No --resume and no --session: the replacement mints its own identity.
    expect(spawn).toHaveBeenCalledWith(
      '/node',
      ['/dsh/lib/bin.js', '--profile', 'tui'],
      { cwd: '/work/space', stdio: 'inherit' },
    )
    expect(exit).toHaveBeenCalledWith(0)
  })
})

describe('goodbye message', () => {
  it('names the profile and session id', () => {
    expect(formatGoodbyeMessage('tui', SessionId('main-session')))
      .toBe('To resume this session: dsh --profile tui --resume main-session')
  })
})
