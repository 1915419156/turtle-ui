/**
 * The terminal app's ordinary command provider: it owns the
 * `dsh --profile tui` flag family
 * (`--resume`, `--session`, `--skill`) and its `--help` text, and provides the
 * session identity this process drives as {@link TUI_STARTUP_SERVICE}.
 *
 * It also publishes the launcher-side host facts the terminal reads: an
 * in-place resume host (see {@link TUI_RESUME_HOST_KEY}), the exit line naming
 * how to resume the session (see {@link TUI_GOODBYE_MESSAGE_KEY}), and the
 * guided fresh session's first skill (see {@link INITIAL_SKILL_KEY}). Those are
 * derived from the profile this process booted — `profileContext`, provided by
 * the dsh launcher — and are simply absent when the app is mounted without one.
 *
 * The agent-loop and TUI rows inject this service before evaluating their
 * own config expressions, so the terminal can never open on the wrong session
 * and `--help` prints without starting an agent.
 * @module @deepseek-ai/dsh-tui/startup
 */

import { randomUUID } from 'node:crypto'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  INITIAL_SKILL_KEY,
  TUI_GOODBYE_MESSAGE_KEY,
  TUI_RESUME_HOST_KEY,
} from './host-keys.ts'
import { createResumeHost, formatGoodbyeMessage, launcherEnvironment, resolveLauncherInvocation } from './launcher.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the session identity can be resolved. */
export const inject = ['cmdlineArgs']

/** The service this row provides and the session-bound rows read. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/**
 * What the session-bound rows read from {@link TUI_STARTUP_SERVICE}. Exactly
 * one of the two is present: the provider rejects both selectors together,
 * and resuming replaces the fresh identity rather than adding to it.
 */
export interface TuiStartupValues {
  /** The fresh session to create; absent when resuming. */
  sessionId?: SessionId
  /** The persisted session to continue; absent unless `--resume` named one. */
  resumeSessionId?: SessionId
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Open the interactive terminal UI on a fresh or persisted session.')
    .helpOption('-h, --help', 'show this help')
    .option('-r, --resume <session>', 'resume a persisted session by id instead of starting a fresh one')
    .option('-s, --session <id>', 'use an explicit id for the fresh session')
    .option('--skill <name>', 'load this skill as a fresh session\'s first turn (guided sessions)')
    .addHelpText('after', `
Examples:
  dsh --profile tui                       start a new session
  dsh --profile tui --resume <session>    continue a persisted session
  dsh --profile tui --session review      start a named fresh session
  dsh --profile tui --skill migrate       start a fresh session on a guided skill
`)
}

/** The tui flag family, as commander parsed it. */
interface TuiOptions {
  resume?: string
  session?: string
  skill?: string
}

/** The session identity this invocation asked for, plus its guided-session seed. */
interface ResolvedStartup {
  values: TuiStartupValues
  initialSkill?: string
}

/**
 * Resolve the session identity this invocation asked for.
 * @param program - the parsed tui command.
 * @returns the session-bound rows' service value and the optional first-turn skill.
 */
function resolveTuiStartup(program: Command): ResolvedStartup {
  const options = program.opts<TuiOptions>()
  if (options.resume !== undefined && options.session !== undefined) {
    program.error('error: --resume continues an existing session and --session names one to create; pass only one')
  }
  if (options.resume !== undefined && options.skill !== undefined) {
    program.error('error: --resume continues an existing session and --skill seeds a fresh one; pass only one')
  }
  // Commander passes option values verbatim and both published identities are
  // matched exactly downstream (skill names against the registry, resume ids
  // against the session store), so the flag boundary is where shell-quoting
  // padding is removed. The emptiness checks then read the stored value itself.
  const selected = (options.resume ?? options.session)?.trim()
  if (selected === '') program.error('error: the session id must not be empty')
  const skill = options.skill?.trim()
  if (skill === '') program.error('error: the skill name must not be empty')
  const sessionId = SessionId(selected ?? `session-${randomUUID()}`)
  return {
    values: options.resume === undefined ? { sessionId } : { resumeSessionId: sessionId },
    ...skill === undefined ? {} : { initialSkill: skill },
  }
}

/**
 * Publish the launcher-side host facts for the resolved session. Each is
 * omitted when the profile cannot supply it: no `profileContext` means the app
 * was not launched by dsh, so there is no launcher to hand off to and no
 * invocation to name in the exit line. A key an embedding launcher already
 * provided is left alone — `ctx.provide` rejects a second registration of the
 * same service, and the embedding launcher's own host wins for its process.
 * @param ctx - plugin context carrying optional launcher state.
 * @param startup - the resolved session identity and guided-session seed.
 */
function provideLauncherHost(ctx: Context, startup: ResolvedStartup): void {
  const absent = (name: string): boolean => ctx.get(name, false) === undefined
  const environment = launcherEnvironment(ctx)
  if (environment !== undefined) {
    const invocation = resolveLauncherInvocation(environment.installAnchor)
    if (invocation !== undefined && absent(TUI_RESUME_HOST_KEY)) {
      ctx.provide(TUI_RESUME_HOST_KEY, createResumeHost({
        invocation,
        profile: environment.profile,
      }))
    }
    const sessionId = startup.values.sessionId ?? startup.values.resumeSessionId
    /* v8 ignore next -- exactly one identity is present, as resolveTuiStartup guarantees. */
    if (sessionId !== undefined && absent(TUI_GOODBYE_MESSAGE_KEY)) {
      ctx.provide(TUI_GOODBYE_MESSAGE_KEY, formatGoodbyeMessage(environment.profile, sessionId))
    }
  }
  if (startup.initialSkill !== undefined && absent(INITIAL_SKILL_KEY)) {
    ctx.provide(INITIAL_SKILL_KEY, startup.initialSkill)
  }
}

/**
 * Resolve the session identity the rest of this app's rows read. The
 * command's action publishes the identity; conflicting or empty selectors are
 * usage errors, so on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const startup = resolveTuiStartup(program)
    provideLauncherHost(ctx, startup)
    ctx.provide(TUI_STARTUP_SERVICE, startup.values)
  })
  parseCmdline(ctx, program)
}
