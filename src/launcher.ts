/**
 * Launcher-side facts and host for the terminal app: where this process was
 * booted from (profile name and dsh installation), the in-place resume handoff
 * that re-executes the launcher into a selected session's own workspace, and
 * the exit line naming how to come back to a session.
 *
 * The handoff is deliberately synchronous after it commits: the resume
 * controller has already released the terminal, so the replacement process
 * inherits the terminal and this one only mirrors its exit status. A failure to
 * start the replacement rejects before the exit boundary, letting the caller
 * restore its own terminal and report.
 * @module @deepseek-ai/dsh-tui/launcher
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiResumeHost } from './runtime.ts'

/** How to re-invoke the dsh launcher that booted this profile. */
export interface LauncherInvocation {
  /** Executable to run — the Node.js binary hosting the launcher. */
  readonly command: string
  /** Arguments that precede the app's own flag family. */
  readonly args: readonly string[]
}

/**
 * The launcher facts a profile boot supplies. Both fields come from the
 * profile's `profileContext`, which a launcher provides before any tree entry
 * mounts; a process booted without one (tests, embedding) can neither hand a
 * session off nor name a resume command.
 */
export interface LauncherEnvironment {
  /** Profile name this process booted, e.g. `tui`. */
  readonly profile: string
  /** Path of the booted dsh app package's `package.json`. */
  readonly installAnchor: string | undefined
}

/** Spawn boundary used by the handoff; replaceable by tests. */
export type SpawnSyncBoundary = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: 'inherit' },
) => { error?: Error; status: number | null }

/**
 * Read the launcher facts out of a context. `profileContext` is provided by the
 * dsh launcher and typed by `@deepseek-ai/dsh-app-boot`, which this package
 * deliberately does not depend on: the read is structural, and a boot without
 * the service yields `undefined`.
 * @param ctx - the plugin context carrying optional launcher state.
 * @returns the environment, or `undefined` outside a dsh-launched profile.
 */
export function launcherEnvironment(ctx: {
  get(name: string, strict?: boolean): unknown
}): LauncherEnvironment | undefined {
  const profileContext = ctx.get('profileContext', false) as {
    name?: unknown
    installAnchor?: unknown
  } | undefined
  if (profileContext === undefined || typeof profileContext.name !== 'string') return undefined
  return {
    profile: profileContext.name,
    installAnchor: typeof profileContext.installAnchor === 'string'
      ? profileContext.installAnchor
      : undefined,
  }
}

/**
 * Resolve the command that re-invokes this process's dsh launcher. The anchor
 * is a path inside the booted dsh package (its `package.json`), so this
 * resolves the launcher's own `bin` entry under the current Node.js binary —
 * independent of PATH and of how the profile was installed.
 * @param installAnchor - absolute path of the dsh app package's `package.json`.
 * @param execPath - Node.js executable; defaults to the current process.
 * @returns the invocation, or `undefined` when the anchor cannot supply one.
 */
export function resolveLauncherInvocation(
  installAnchor: string | undefined,
  execPath: string = process.execPath,
): LauncherInvocation | undefined {
  if (installAnchor === undefined) return undefined
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(installAnchor, 'utf8'))
  } catch {
    return undefined
  }
  const bin = (manifest as { bin?: unknown }).bin
  const relative = typeof bin === 'string'
    ? bin
    : typeof bin === 'object' && bin !== null && typeof (bin as Record<string, unknown>).dsh === 'string'
      ? (bin as Record<string, string>).dsh
      : undefined
  /* v8 ignore next -- an anchored dsh package always declares its dsh bin. */
  if (relative === undefined) return undefined
  return { command: execPath, args: [resolve(dirname(installAnchor), relative)] }
}

/** The line the TUI prints on exit, naming the command that resumes the session. */
export function formatGoodbyeMessage(profile: string, sessionId: SessionId): string {
  return `To resume this session: dsh --profile ${profile} --resume ${sessionId}`
}

/** Collaborators for the in-place resume host. */
export interface ResumeHostOptions {
  /** How to re-invoke the launcher. */
  readonly invocation: LauncherInvocation
  /** Profile name the replacement process boots. */
  readonly profile: string
  /** Spawn boundary; defaults to synchronous spawn with inherited stdio. */
  readonly spawn?: SpawnSyncBoundary
  /**
   * Exit boundary reached after the replacement process ends. The default ends
   * this process with the same status; a boundary that returns rejects instead,
   * so the caller reports the handoff as failed rather than silently resuming
   * its own loop.
   */
  readonly exit?: (code: number) => void
}

/**
 * Build the resume host: spawn the launcher resuming `sessionId` in the
 * session's own workspace and mirror its exit status. Success does not return.
 * @param options - invocation, profile, and the spawn/exit boundaries.
 * @returns the host the TUI's `/resume` and `/new` handoffs call.
 */
export function createResumeHost(options: ResumeHostOptions): TuiResumeHost {
  const spawn = options.spawn ?? ((command, args, spawnOptions) =>
    spawnSync(command, [...args], spawnOptions))
  const exit = options.exit ?? ((code: number) => { process.exit(code) })
  /**
   * Replace this process with a launcher invocation of `args` in `cwd`. On
   * success this never settles: the exit boundary ends the process, so a
   * boundary that returns rejects as a failed handoff.
   */
  const launch = (args: readonly string[], cwd: string): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      let result: { error?: Error; status: number | null }
      try {
        result = spawn(options.invocation.command, args, { cwd, stdio: 'inherit' })
      } catch (error: unknown) {
        reject(new Error(`cannot re-exec the dsh launcher: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
      if (result.error !== undefined) {
        reject(new Error(`cannot re-exec the dsh launcher: ${result.error.message}`))
        return
      }
      const status = result.status ?? 1
      exit(status)
      reject(new Error(`launcher exited with status ${status} without replacing this process`))
    })
  return {
    handoff(sessionId, cwd) {
      return launch(
        [...options.invocation.args, '--profile', options.profile, '--resume', sessionId],
        cwd,
      )
    },
    handoffNew(cwd) {
      // A fresh session with no selectors is exactly a bare launcher invocation:
      // the app mints its own session id, so nothing here needs to.
      return launch([...options.invocation.args, '--profile', options.profile], cwd)
    },
  }
}
