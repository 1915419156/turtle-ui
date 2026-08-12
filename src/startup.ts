/**
 * The terminal app's ordinary command provider: it owns the
 * `dsh --profile tui` flag family
 * (`--resume`, `--session`) and its `--help` text, and provides the session
 * identity this process drives as {@link TUI_STARTUP_SERVICE}.
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
    .addHelpText('after', `
Examples:
  dsh --profile tui                       start a new session
  dsh --profile tui --resume <session>    continue a persisted session
  dsh --profile tui --session review      start a named fresh session
`)
}

/** The tui flag family, as commander parsed it. */
interface TuiOptions {
  resume?: string
  session?: string
}

/**
 * Resolve the session identity this invocation asked for.
 * @param program - the parsed tui command.
 * @returns the session-bound rows' service value.
 */
function resolveTuiStartup(program: Command): TuiStartupValues {
  const options = program.opts<TuiOptions>()
  if (options.resume !== undefined && options.session !== undefined) {
    program.error('error: --resume continues an existing session and --session names one to create; pass only one')
  }
  const selected = options.resume ?? options.session
  if (selected?.trim() === '') program.error('error: the session id must not be empty')
  const sessionId = SessionId(selected ?? `session-${randomUUID()}`)
  return options.resume === undefined ? { sessionId } : { resumeSessionId: sessionId }
}

/**
 * Resolve the session identity the rest of this app's rows read. The
 * command's action publishes the identity; conflicting or empty selectors are
 * usage errors, so on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => { ctx.provide(TUI_STARTUP_SERVICE, resolveTuiStartup(program)) })
  parseCmdline(ctx, program)
}
